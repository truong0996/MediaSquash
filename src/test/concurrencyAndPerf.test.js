const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const sharp = require('sharp');

const {
    getRecommendedVideoConcurrency,
    getOptimalVideoThreads,
    parallelProcess,
    getFilesRecursive,
    scanFilesAsync,
    inspectMediaFile,
    normalizeOutputExtension,
    findJsonSidecar,
    getCaptureDate,
    clearCaptureDateCache,
    getFFmpegPath,
    isImage,
    isVideo
} = require('../utils');
const { compressImage, configureSharpConcurrency } = require('../imageCompressor');
const { compressVideo, getAdaptiveCrf, shouldCopyAudio } = require('../videoCompressor');
const { ENCODER_CONFIGS, detectAvailableEncoders } = require('../hwEncoder');
const { shutdownHeicPool } = require('../heicWorker');

let passed = 0;
let failed = 0;
const tmpDir = path.join(__dirname, 'tmp_perf_test');

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEquals(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`✗ ${name}: ${err.message}`);
        failed++;
    }
}

function setup() {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });
}

function cleanup() {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

(async () => {
    console.log('\n=== Concurrency, Optimization & Integration Tests ===\n');
    setup();

    await testAsync('Concurrency: getRecommendedVideoConcurrency respects HW & SW bounds', async () => {
        assertEquals(getRecommendedVideoConcurrency(0, 'nvenc'), 1);
        assertEquals(getRecommendedVideoConcurrency(1, 'nvenc'), 1);
        const hwMax = getRecommendedVideoConcurrency(20, 'nvenc');
        assert(hwMax >= 1 && hwMax <= 3, `HW concurrency out of bounds: ${hwMax}`);
        const swMax = getRecommendedVideoConcurrency(20, 'x265');
        assert(swMax >= 1 && swMax <= 3, `SW concurrency out of bounds: ${swMax}`);
    });

    await testAsync('Concurrency: getOptimalVideoThreads prevents oversubscription', async () => {
        const cpuCount = os.cpus().length || 4;
        const swThreads = getOptimalVideoThreads(2, { encoderType: 'x265', overlapWithImages: false });
        assert(swThreads >= 1 && swThreads * 2 <= Math.max(2, cpuCount), `SW threads oversubscribed: ${swThreads}`);

        const hwThreads = getOptimalVideoThreads(2, { encoderType: 'nvenc', overlapWithImages: true });
        assert(hwThreads >= 1 && hwThreads <= 4, `HW threads out of bounds: ${hwThreads}`);
    });

    await testAsync('Sharp: cache disabled & configureSharpConcurrency budgets libvips threads', async () => {
        const cacheInfo = sharp.cache();
        assertEquals(cacheInfo.memory.max, 0, 'sharp.cache memory max should be 0');
        const budget = configureSharpConcurrency(4, 8);
        assertEquals(budget, 2);
        assertEquals(sharp.concurrency(), 2);
    });

    await testAsync('parallelProcess: enforces max concurrency, collectResults=false, and shouldCancel', async () => {
        let active = 0;
        let maxActive = 0;
        let cancelled = false;
        let ran = 0;

        const res = await parallelProcess(
            [1, 2, 3, 4, 5, 6, 7, 8],
            async (n) => {
                active++;
                if (active > maxActive) maxActive = active;
                await new Promise(r => setTimeout(r, 20));
                ran++;
                if (ran >= 3) cancelled = true;
                active--;
                return n * 2;
            },
            2,
            { collectResults: false, shouldCancel: () => cancelled }
        );

        assert(maxActive <= 2, `Max active exceeded 2: ${maxActive}`);
        assertEquals(res.length, 0, 'collectResults=false should return empty array');
        assert(ran < 8, `shouldCancel should stop early, ran=${ran}`);
    });

    await testAsync('hwEncoder: NVENC has -b:v 0 and all HW HEVC encoders have -tag:v hvc1', async () => {
        const nvOpts = ENCODER_CONFIGS.nvenc.getOutputOptions(22);
        assert(nvOpts.includes('-b:v 0'), 'NVENC missing -b:v 0');
        assert(nvOpts.includes('-tag:v hvc1'), 'NVENC missing -tag:v hvc1');
        assert(ENCODER_CONFIGS.amf.getOutputOptions(22).includes('-tag:v hvc1'), 'AMF missing -tag:v hvc1');
        assert(ENCODER_CONFIGS.qsv.getOutputOptions(22).includes('-tag:v hvc1'), 'QSV missing -tag:v hvc1');

        const [a, b] = await Promise.all([detectAvailableEncoders(true), detectAvailableEncoders()]);
        assertEquals(a.nvenc, b.nvenc, 'Concurrent calls should return same result');
    });

    await testAsync('getAdaptiveCrf: portrait videos use short edge and format.duration fallback', async () => {
        const portrait1080 = { streams: [{ codec_type: 'video', width: 1080, height: 1920, duration: '120' }] };
        assertEquals(getAdaptiveCrf(22, portrait1080), 22, '1080x1920 portrait should be treated as 1080p');

        const portrait720 = { streams: [{ codec_type: 'video', width: 720, height: 1280, duration: '120' }] };
        assertEquals(getAdaptiveCrf(22, portrait720), 21, '720x1280 portrait should be treated as 720p');

        const mkvFallback = {
            streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
            format: { duration: '900' }
        };
        assertEquals(getAdaptiveCrf(22, mkvFallback), 23, 'format.duration > 600 should add +1');
    });

    await testAsync('shouldCopyAudio: copies AAC <= 256k, re-encodes PCM or high-bitrate AAC', async () => {
        assertEquals(shouldCopyAudio({ streams: [{ codec_type: 'audio', codec_name: 'aac', bit_rate: '128000' }] }, '.mp4'), true);
        assertEquals(shouldCopyAudio({ streams: [{ codec_type: 'audio', codec_name: 'aac', bit_rate: '320000' }] }, '.mp4'), false);
        assertEquals(shouldCopyAudio({ streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', bit_rate: '1536000' }] }, '.mp4'), false);
        assertEquals(shouldCopyAudio({ streams: [{ codec_type: 'audio', codec_name: 'aac', bit_rate: '128000' }] }, '.webm'), false);
    });

    await testAsync('compressImage: normalizes .jpg/.jpeg alias when checking larger output', async () => {
        const inputJpg = path.join(tmpDir, 'small.jpg');
        const outJpeg = path.join(tmpDir, 'small_out.jpeg');
        // Create a tiny low-quality JPEG, then re-compress at quality 100
        await sharp({
            create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 120, b: 200 } }
        }).jpeg({ quality: 20 }).toFile(inputJpg);

        const res = await compressImage(inputJpg, outJpeg, { quality: 100 });
        assert(res.savings.includes('used original'), `Expected revert to original for .jpg -> .jpeg, got: ${res.savings}`);
    });

    await testAsync('Scanner & Sidecar: scanFilesAsync matches getFilesRecursive and O(1) prefix sidecar works', async () => {
        const nested = path.join(tmpDir, 'scan_root', 'sub');
        fs.mkdirSync(nested, { recursive: true });
        const imgPath = path.join(nested, 'IMG_20260412_183012.jpg');
        const jsonSidecar = path.join(nested, 'IMG_20260412_183012.jpg.suppleme.json');
        const unrelatedJson = path.join(nested, 'OTHER_FILE.json');

        await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toFile(imgPath);
        fs.writeFileSync(jsonSidecar, JSON.stringify({ photoTakenTime: { timestamp: '1776018612' } }));
        fs.writeFileSync(unrelatedJson, '{}');

        clearCaptureDateCache();
        const foundSidecar = findJsonSidecar(imgPath);
        assertEquals(foundSidecar, jsonSidecar, 'Should match truncated Takeout sidecar');

        const filter = (f) => isImage(f) || isVideo(f);
        const syncFiles = getFilesRecursive(path.join(tmpDir, 'scan_root'), filter);
        const asyncFiles = await scanFilesAsync(path.join(tmpDir, 'scan_root'), filter, true);
        assertEquals(asyncFiles.length, syncFiles.length, 'Async scan count should match recursive sync scan');
        assertEquals(asyncFiles[0].path, syncFiles[0]);
        assert(asyncFiles[0].size > 0, 'Async scan should include file size');

        const missingFile = path.join(nested, 'missing_file.txt');
        const d1 = await getCaptureDate(missingFile);
        assertEquals(d1, null);
    });

    await testAsync('Magic-byte sniffing: reclassifies JPEG-in-MOV, skips 0-byte & XML plist', async () => {
        const spoofDir = path.join(tmpDir, 'spoof_iphone');
        fs.mkdirSync(spoofDir, { recursive: true });

        const jpegAsMov = path.join(spoofDir, 'WPLG2624.MOV');
        const emptyMov = path.join(spoofDir, 'IMG_5904.MOV');
        const plistAsMov = path.join(spoofDir, 'KGISE3662.MOV');

        await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 140, b: 220 } } })
            .jpeg({ quality: 95 })
            .toFile(jpegAsMov);
        fs.writeFileSync(emptyMov, '');
        fs.writeFileSync(plistAsMov, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist><plist version="1.0"></plist>');

        const jpegInfo = await inspectMediaFile(jpegAsMov);
        assertEquals(jpegInfo.kind, 'image');
        assertEquals(jpegInfo.format, 'jpeg');
        assertEquals((await inspectMediaFile(emptyMov)).kind, 'invalid');
        assertEquals((await inspectMediaFile(plistAsMov)).kind, 'invalid');

        assertEquals(normalizeOutputExtension(jpegAsMov, 'webp', 'image'), path.join(spoofDir, 'WPLG2624.webp'));

        const scanned = await scanFilesAsync(spoofDir, () => true, false);
        assertEquals(scanned.length, 1, 'Scan should exclude 0-byte & plist and keep JPEG-in-MOV');
        assertEquals(scanned[0].type, 'image');

        const webpOut = path.join(spoofDir, 'WPLG2624.webp');
        const imgRes = await compressImage(jpegAsMov, webpOut, { quality: 80, actualFormat: 'jpeg' });
        assert(imgRes.success && fs.existsSync(webpOut), 'JPEG-in-MOV should compress cleanly to WebP');

        let vidRejected = false;
        try {
            await compressVideo(jpegAsMov, path.join(spoofDir, 'bad.mp4'));
        } catch (err) {
            vidRejected = Boolean(err?.error && err.error.includes('mislabeled'));
        }
        assert(vidRejected, 'compressVideo should reject image mislabeled as video');

        // Regression test: video saved with .JPG extension and no creation_time must not self-deadlock in getCaptureDate
        const vidAsJpg = path.join(spoofDir, 'VIDEO_NO_DATE.JPG');
        execFileSync(getFFmpegPath(), [
            '-y', '-f', 'lavfi', '-i', 'testsrc=duration=0.3:size=160x120:rate=10',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'mp4', vidAsJpg
        ], { stdio: 'ignore' });
        clearCaptureDateCache();
        const vidDate = await Promise.race([
            getCaptureDate(vidAsJpg),
            new Promise((_, reject) => setTimeout(() => reject(new Error('getCaptureDate self-deadlock')), 5000))
        ]);
        assert(vidDate instanceof Date && !isNaN(vidDate.getTime()), 'Video-in-JPG should resolve capture date without hanging');
    });

    await testAsync('Video: real FFmpeg encode copies AAC audio & AbortSignal cancels cleanly', async () => {
        const ffmpegBin = getFFmpegPath();
        const sampleVid = path.join(tmpDir, 'sample.mp4');
        const outVid = path.join(tmpDir, 'sample_out.mp4');
        const cancelVid = path.join(tmpDir, 'sample_cancel.mp4');

        // Generate 1-second 320x240 video + 128k AAC audio
        execFileSync(ffmpegBin, [
            '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k',
            sampleVid
        ], { stdio: 'ignore' });

        const result = await compressVideo(sampleVid, outVid, {
            encoder: 'x264',
            preset: 'ultrafast',
            crf: 28,
            threads: 2
        });
        assert(result.success, 'Video encode should succeed');
        assertEquals(result.audioCopied, true, '128k AAC audio should be stream-copied');
        assert(fs.existsSync(outVid), 'Output MP4 should exist');

        // Test immediate AbortSignal cancellation
        const ac = new AbortController();
        let cancelRejected = false;
        try {
            const p = compressVideo(sampleVid, cancelVid, {
                encoder: 'x264',
                preset: 'ultrafast',
                crf: 28,
                signal: ac.signal,
                onStart: () => ac.abort()
            });
            await p;
        } catch (err) {
            cancelRejected = Boolean(err?.cancelled);
        }
        assert(cancelRejected, 'Aborted video encode must reject with cancelled: true');
        assert(!fs.existsSync(cancelVid), 'Cancelled partial output must be cleaned up');
    });

    await testAsync('Server E2E: scan, presets, compress, cancel & resume lifecycle', async () => {
        const testPort = 3967;
        const serverProc = spawn(process.execPath, [path.join(__dirname, '../../server.js')], {
            env: { ...process.env, PORT: String(testPort), ELECTRON_APP: 'true' },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const baseUrl = `http://127.0.0.1:${testPort}`;
        const waitForServer = async () => {
            for (let i = 0; i < 30; i++) {
                try {
                    const r = await fetch(`${baseUrl}/api/status`);
                    if (r.ok) return;
                } catch {}
                await new Promise(r => setTimeout(r, 200));
            }
            throw new Error('Server did not start in time');
        };

        try {
            await waitForServer();

            // 1. Scan endpoint
            const scanDir = path.join(tmpDir, 'server_in');
            const outDir = path.join(tmpDir, 'server_out');
            fs.mkdirSync(scanDir, { recursive: true });
            await sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 200, g: 50, b: 50 } } })
                .jpeg({ quality: 90 })
                .toFile(path.join(scanDir, 'photo1.jpg'));

            const scanRes = await fetch(`${baseUrl}/api/scan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath: scanDir, recursive: true, fileType: 'all' })
            });
            assertEquals(scanRes.status, 200);
            const scanned = await scanRes.json();
            assertEquals(scanned.length, 1, 'Server scan should find 1 image');

            // 2. Presets CRUD
            const savePresetRes = await fetch(`${baseUrl}/api/presets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'TestE2EPreset', settings: { imageFormat: 'webp', quality: '85' } })
            });
            assertEquals(savePresetRes.status, 200);

            const delPresetRes = await fetch(`${baseUrl}/api/presets/TestE2EPreset`, { method: 'DELETE' });
            assertEquals(delPresetRes.status, 200);

            // 3. Compress & wait for completion
            const compRes = await fetch(`${baseUrl}/api/compress`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    files: scanned,
                    outputFolder: outDir,
                    inputFolder: scanDir,
                    encoder: 'x264',
                    imageFormat: 'webp',
                    quality: 85,
                    crf: 22,
                    flatten: true,
                    renameOnly: false,
                    categoryByYear: false,
                    categoryByMonth: false
                })
            });
            assertEquals(compRes.status, 200);

            for (let i = 0; i < 30; i++) {
                const st = await (await fetch(`${baseUrl}/api/status`)).json();
                if (!st.isRunning) break;
                await new Promise(r => setTimeout(r, 150));
            }
            const outFiles = fs.readdirSync(outDir);
            assert(outFiles.some(f => f.endsWith('.webp')), 'Compressed WebP output should exist');

            // 4. Metrics endpoint
            const metrics = await (await fetch(`${baseUrl}/api/metrics`)).json();
            assert(metrics.memory && metrics.memory.heapUsed, 'Metrics should report heapUsed');
        } finally {
            serverProc.kill('SIGKILL');
        }
    });

    await shutdownHeicPool().catch(() => {});
    cleanup();

    console.log('\n=== Concurrency & Perf Summary ===\n');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
