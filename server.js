/**
 * Web Local GUI Server
 * Express server for Media Compressor GUI
 */

const os = require('os');
if (!process.env.UV_THREADPOOL_SIZE) {
    const cpuCount = os.cpus().length || 4;
    process.env.UV_THREADPOOL_SIZE = String(Math.min(Math.max(cpuCount, 8), 16));
}

const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('./src/logger');

const { compressImage, configureSharpConcurrency } = require('./src/imageCompressor');
const { compressVideo, detectAvailableEncoders, getAdaptiveCrf } = require('./src/videoCompressor');
const { getEncoderConfig } = require('./src/hwEncoder');
const { shutdownHeicPool } = require('./src/heicWorker');
const {
    isImage,
    isVideo,
    scanFilesAsync,
    formatFileSize,
    setFileMetadataAsync,
    getCaptureDate,
    formatDateForFilename,
    normalizeOutputExtension,
    validateQuality,
    validateCrf,
    validateImageFormat,
    validateEncoder,
    clearCaptureDateCache,
    getAvailableMemory,
    getRecommendedVideoConcurrency,
    getOptimalVideoThreads,
    isLowMemory,
    isAlreadyProcessed,
    inspectMediaFile,
    probeVideo,
    evictProbeCache,
    ensureDirCached,
    clearCreatedDirCache,
    parallelProcess,
    getWritableDataDir
} = require('./src/utils');

const app = express();
const BASE_PORT = process.env.PORT || 3847;
// The API scans and writes arbitrary filesystem paths with no authentication,
// so it must not be reachable from the network.
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'gui')));

const WRITABLE_DIR = getWritableDataDir();
const JOB_STATE_FILE = path.join(WRITABLE_DIR, 'tmp_review', 'job-state.json');
const PRESETS_DIR = path.join(WRITABLE_DIR, 'presets');

// Active process tracking for immediate cancellation & shutdown cleanup
const activeFfmpegProcesses = new Set();
let currentJobAbortController = null;

function cleanupActiveProcesses() {
    if (currentJobAbortController) {
        try {
            currentJobAbortController.abort();
        } catch {}
    }
    for (const proc of activeFfmpegProcesses) {
        try {
            proc.kill('SIGKILL');
        } catch {}
    }
    activeFfmpegProcesses.clear();
}

process.on('SIGINT', () => {
    cleanupActiveProcesses();
    process.exit(0);
});

process.on('SIGTERM', () => {
    cleanupActiveProcesses();
    process.exit(0);
});

// State for compression progress
let compressionState = {
    isRunning: false,
    shouldCancel: false,
    currentFile: null,
    progress: 0,
    processed: 0,
    total: 0,
    results: null,
    failedFiles: []
};

function initializeJobState(total) {
    compressionState = {
        isRunning: true,
        shouldCancel: false,
        currentFile: null,
        progress: 0,
        processed: 0,
        total,
        failedFiles: [],
        results: {
            success: 0,
            failed: 0,
            totalOriginal: 0,
            totalCompressed: 0,
            startTime: Date.now()
        }
    };
}

let jobStateWriteTimer = null;
let pendingJobStatePayload = null;

async function writeJobStateNow(state) {
    try {
        const dir = path.dirname(JOB_STATE_FILE);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(JOB_STATE_FILE, JSON.stringify(state));
    } catch (err) {
        logger.warn('Failed to save job state:', err.message);
    }
}

function scheduleJobStateSave(state) {
    pendingJobStatePayload = state;
    if (jobStateWriteTimer) return;
    jobStateWriteTimer = setTimeout(async () => {
        jobStateWriteTimer = null;
        const payload = pendingJobStatePayload;
        pendingJobStatePayload = null;
        if (payload) {
            await writeJobStateNow(payload);
        }
    }, 2000);
    if (jobStateWriteTimer.unref) jobStateWriteTimer.unref();
}

function loadJobState() {
    try {
        if (fs.existsSync(JOB_STATE_FILE)) {
            return JSON.parse(fs.readFileSync(JOB_STATE_FILE, 'utf8'));
        }
    } catch (err) {
        logger.warn('Failed to load job state:', err.message);
    }
    return null;
}

async function clearJobState() {
    if (jobStateWriteTimer) {
        clearTimeout(jobStateWriteTimer);
        jobStateWriteTimer = null;
    }
    pendingJobStatePayload = null;
    try {
        if (fs.existsSync(JOB_STATE_FILE)) {
            await fs.promises.unlink(JOB_STATE_FILE);
        }
    } catch (err) {
        logger.warn('Failed to clear job state:', err.message);
    }
}

// SSE clients for real-time updates
let sseClients = [];

function sendSSE(event, data) {
    if (sseClients.length === 0) return;

    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let dead = null;

    for (const client of sseClients) {
        if (client.writableEnded || client.destroyed) {
            (dead || (dead = [])).push(client);
            continue;
        }
        try {
            client.write(payload);
        } catch {
            (dead || (dead = [])).push(client);
        }
    }

    if (dead) {
        sseClients = sseClients.filter(client => !dead.includes(client));
    }
}

const PROGRESS_THROTTLE_MS = 250;
const progressThrottle = new Map();

function sendFileProgress(index, percent) {
    const now = Date.now();
    const last = progressThrottle.get(index);
    const rounded = Math.round(percent);

    if (last) {
        if (rounded === last.percent) return;
        if (rounded < 100 && now - last.at < PROGRESS_THROTTLE_MS) return;
    }

    progressThrottle.set(index, { at: now, percent: rounded });
    sendSSE('file-progress', { index, percent: rounded });
}

// ============ API Routes ============

app.get('/api/encoders', async (req, res) => {
    try {
        const encoders = await detectAvailableEncoders();
        res.json(encoders);
    } catch {
        res.json({ nvenc: false, amf: false, qsv: false, x264: true, x265: true });
    }
});

// Scan folder asynchronously without blocking the event loop
app.post('/api/scan', async (req, res) => {
    const { folderPath, recursive, fileType } = req.body;

    if (!folderPath) {
        return res.status(400).json({ error: 'Invalid folder path' });
    }

    try {
        const folderStat = await fs.promises.stat(folderPath).catch(() => null);
        if (!folderStat || !folderStat.isDirectory()) {
            return res.status(400).json({ error: 'Invalid folder path' });
        }

        const mediaExtFilter = (f) => isImage(f) || isVideo(f);
        const scanned = await scanFilesAsync(folderPath, mediaExtFilter, Boolean(recursive));
        const filtered = scanned.filter(item => {
            if (fileType === 'image') return item.type === 'image';
            if (fileType === 'video') return item.type === 'video';
            return true;
        });

        const result = filtered.map(({ path: filePath, size, type, actualFormat }) => ({
            path: filePath,
            name: path.basename(filePath),
            type,
            actualFormat,
            size,
            sizeFormatted: formatFileSize(size)
        }));

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Scan explicit file or directory paths asynchronously (used by drag-and-drop)
app.post('/api/scan-files', async (req, res) => {
    const { filePaths, recursive, fileType } = req.body;

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return res.status(400).json({ error: 'No file paths provided' });
    }

    try {
        const mediaExtFilter = (filePath) => isImage(filePath) || isVideo(filePath);
        const matchesRequestedType = (actualType) => {
            if (fileType === 'image') return actualType === 'image';
            if (fileType === 'video') return actualType === 'video';
            return actualType === 'image' || actualType === 'video';
        };

        const seen = new Set();
        const result = [];

        const pushItem = (filePath, baseDir, size, type, actualFormat) => {
            if (!filePath || seen.has(filePath) || !matchesRequestedType(type)) return;
            seen.add(filePath);
            result.push({
                path: filePath,
                baseDir,
                name: path.basename(filePath),
                type,
                actualFormat,
                size,
                sizeFormatted: formatFileSize(size)
            });
        };

        for (const rawPath of filePaths) {
            if (!rawPath) continue;
            const resolvedPath = path.resolve(rawPath);
            const stats = await fs.promises.stat(resolvedPath).catch(() => null);
            if (!stats) continue;

            if (stats.isDirectory()) {
                const scanned = await scanFilesAsync(resolvedPath, mediaExtFilter, Boolean(recursive));
                for (const item of scanned) {
                    pushItem(item.path, resolvedPath, item.size, item.type, item.actualFormat);
                }
            } else if (stats.isFile() && mediaExtFilter(resolvedPath)) {
                const info = await inspectMediaFile(resolvedPath, stats.size);
                if (info.kind !== 'invalid') {
                    pushItem(resolvedPath, path.dirname(resolvedPath), stats.size, info.kind, info.format || null);
                }
            }
        }

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start compression
app.post('/api/compress', async (req, res) => {
    let { files, outputFolder, inputFolder, encoder, imageFormat, quality, crf, flatten, renameOnly, categoryByYear, categoryByMonth } = req.body;

    if (compressionState.isRunning) {
        return res.status(400).json({ error: 'Compression already in progress' });
    }

    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files to compress' });
    }

    quality = validateQuality(quality);
    crf = validateCrf(crf);
    encoder = validateEncoder(encoder);
    imageFormat = validateImageFormat(imageFormat);

    if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder, { recursive: true });
    }

    clearCaptureDateCache();
    initializeJobState(files.length);

    const jobMeta = {
        hasJob: true,
        startedAt: new Date().toISOString(),
        files,
        pendingFiles: files,
        outputFolder,
        inputFolder,
        encoder,
        imageFormat,
        quality,
        crf,
        flatten,
        renameOnly,
        categoryByYear,
        categoryByMonth
    };
    await writeJobStateNow(jobMeta);

    res.json({ status: 'started', total: files.length });

    processFiles(files, outputFolder, inputFolder, encoder, imageFormat, parseInt(quality, 10), parseInt(crf, 10), flatten, renameOnly, categoryByYear, categoryByMonth, jobMeta);
});

async function processFiles(files, outputFolder, inputFolder, encoder, imageFormat, quality, crf, flatten, renameOnly, categoryByYear, categoryByMonth, jobMeta = null) {
    const cpuCount = os.cpus().length || 4;
    const freeMem = getAvailableMemory();

    // Resolve encoder once before sizing pools
    let encoderConfig = { type: 'x264' };
    try {
        encoderConfig = await getEncoderConfig(encoder);
    } catch {}

    const usesHardwareEncoder = ['nvenc', 'amf', 'qsv'].includes(encoderConfig.type);

    // Separate images and videos, preserving caller/UI index
    const images = [];
    const videos = [];
    files.forEach((file, arrayIndex) => {
        const uiIndex = typeof file.index === 'number' ? file.index : arrayIndex;
        if (file.type === 'image') {
            images.push({ file, index: uiIndex });
        } else {
            videos.push({ file, index: uiIndex });
        }
    });

    // Largest-First (LPT) video scheduling prevents one big 4K file from straggling alone at the end
    videos.sort((a, b) => (b.file.size || 0) - (a.file.size || 0));

    const VIDEO_CONCURRENCY = getRecommendedVideoConcurrency(videos.length, encoderConfig.type);
    const overlapPools = usesHardwareEncoder && images.length > 0 && videos.length > 0;

    // Scale image concurrency cleanly; AVIF is much heavier per pipeline than WebP/JPEG
    let IMAGE_CONCURRENCY = imageFormat === 'avif'
        ? Math.max(2, Math.min(Math.floor(cpuCount / 2), 4))
        : Math.max(2, Math.min(cpuCount, 8));

    if (overlapPools) {
        IMAGE_CONCURRENCY = Math.max(2, Math.min(IMAGE_CONCURRENCY, Math.max(2, cpuCount - VIDEO_CONCURRENCY)));
    }

    const THREADS_PER_VIDEO = getOptimalVideoThreads(VIDEO_CONCURRENCY, {
        encoderType: encoderConfig.type,
        overlapWithImages: overlapPools
    });

    const imageCoreBudget = overlapPools ? Math.max(2, cpuCount - 2) : cpuCount;
    const sharpThreadsPerWorker = configureSharpConcurrency(IMAGE_CONCURRENCY, imageCoreBudget);

    const memGB = (freeMem / (1024 * 1024 * 1024)).toFixed(1);
    console.log(`⚡ Concurrency: ${IMAGE_CONCURRENCY} images (sharp threads=${sharpThreadsPerWorker}), ${VIDEO_CONCURRENCY} videos (ffmpeg threads=${THREADS_PER_VIDEO}, encoder=${encoderConfig.type})`);
    console.log(`   CPU: ${cpuCount} cores | RAM: ${memGB}GB free | Overlap: ${overlapPools}`);

    if (isLowMemory()) {
        console.log(`   ⚠️  LOW MEMORY WARNING - reduced concurrency`);
    }

    const reservedOutputPaths = new Set();
    progressThrottle.clear();
    clearCreatedDirCache();
    currentJobAbortController = new AbortController();

    const completedPaths = new Set();
    const baseFilesForResume = jobMeta?.files || files;

    const markProcessedForResume = (filePath) => {
        completedPaths.add(filePath);
        if (!jobMeta) return;
        const remaining = baseFilesForResume.filter(f => !completedPaths.has(f.path));
        scheduleJobStateSave({
            ...jobMeta,
            pendingFiles: remaining
        });
    };

    async function processSingleFile(file, index) {
        if (compressionState.shouldCancel || currentJobAbortController?.signal.aborted) {
            return { cancelled: true };
        }

        let captureDate = null;
        let yearFolder = null;
        try {
            captureDate = await getCaptureDate(file.path);
        } catch {
            try {
                const stats = await fs.promises.stat(file.path);
                captureDate = new Date(stats.mtime.getTime() - stats.mtime.getTimezoneOffset() * 60000);
            } catch {}
        }

        if (compressionState.shouldCancel) return { cancelled: true };

        const ext = path.extname(file.path);
        const extLower = ext.toLowerCase();
        const actualType = file.type || (isImage(file.path) ? 'image' : 'video');
        const actualFormat = file.actualFormat || extLower.slice(1);
        const tempOutputPath = normalizeOutputExtension(file.path, imageFormat, actualType);
        const outputExt = path.extname(tempOutputPath);

        let newFilename;
        if (captureDate) {
            const baseName = formatDateForFilename(captureDate);
            newFilename = baseName + outputExt;
            yearFolder = captureDate.getUTCFullYear().toString();
        } else {
            const originalName = path.basename(file.path, ext);
            newFilename = originalName + outputExt;
            yearFolder = 'other';
        }

        let outputPath;
        if (flatten) {
            outputPath = path.join(outputFolder, newFilename);
        } else if (categoryByYear || categoryByMonth) {
            const parts = [outputFolder];
            if (categoryByYear && yearFolder && yearFolder !== 'other') {
                parts.push(yearFolder);
            }
            if (categoryByMonth && captureDate) {
                const pad = (num) => String(num).padStart(2, '0');
                const monthStr = pad(captureDate.getUTCMonth() + 1);
                const yearPrefix = captureDate.getUTCFullYear().toString();
                parts.push(`${yearPrefix}${monthStr}__`);
            }
            parts.push(newFilename);
            outputPath = path.join(...parts);
        } else {
            const relativeRoot = file.baseDir || inputFolder;
            let relativePath = relativeRoot ? path.relative(relativeRoot, file.path) : path.basename(file.path);
            if (!relativeRoot || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                relativePath = path.basename(file.path);
            }
            const relativeDir = path.dirname(relativePath);
            outputPath = path.join(outputFolder, relativeDir, newFilename);
        }

        const inputStat = await fs.promises.stat(file.path);
        const originalSize = inputStat.size;
        const baseOutputPath = outputPath;
        const baseNoExt = newFilename.slice(0, -outputExt.length);
        let counter = 0;

        // Synchronous reservation guarantees zero filename collisions across concurrent workers
        while (true) {
            const candidatePath = counter === 0
                ? baseOutputPath
                : path.join(path.dirname(baseOutputPath), `${baseNoExt}_${counter}${outputExt}`);

            if (reservedOutputPaths.has(candidatePath)) {
                counter++;
                continue;
            }

            let outputStat = null;
            try {
                outputStat = fs.statSync(candidatePath);
            } catch {}

            if (!outputStat) {
                outputPath = candidatePath;
                reservedOutputPaths.add(outputPath);
                break;
            }

            if (!renameOnly && isAlreadyProcessed(file.path, candidatePath, outputStat, inputStat)) {
                reservedOutputPaths.add(candidatePath);
                compressionState.processed++;
                compressionState.results.success++;
                compressionState.results.totalOriginal += originalSize;
                compressionState.results.totalCompressed += outputStat.size;
                markProcessedForResume(file.path);
                sendSSE('file-skipped', { index, name: file.name, sizeSaved: originalSize - outputStat.size });
                sendSSE('overall-progress', {
                    processed: compressionState.processed,
                    total: compressionState.total,
                    percent: (compressionState.processed / compressionState.total) * 100
                });
                return { skipped: true };
            }

            counter++;
        }

        ensureDirCached(path.dirname(outputPath));
        sendSSE('file-start', { index, name: file.name, type: file.type });

        let activeCmd = null;
        try {
            if (originalSize === 0) {
                throw new Error('Empty 0-byte file');
            }
            let result;

            if (renameOnly) {
                if (actualFormat === 'heic' || actualFormat === 'heif') {
                    result = await compressImage(file.path, outputPath, {
                        quality,
                        originalSize,
                        actualFormat,
                        skipDirCheck: true
                    });
                    result.savings = 'Converted from HEIC';
                } else {
                    await fs.promises.copyFile(file.path, outputPath);
                    await setFileMetadataAsync(file.path, outputPath, inputStat);
                    result = {
                        originalSize,
                        compressedSize: originalSize,
                        savings: 'Renamed only'
                    };
                }
            } else if (actualType === 'image') {
                result = await compressImage(file.path, outputPath, {
                    quality,
                    originalSize,
                    actualFormat,
                    skipDirCheck: true
                });
            } else {
                let videoInfo = null;
                let adaptiveCrf = crf;
                try {
                    videoInfo = await probeVideo(file.path);
                    if (videoInfo) adaptiveCrf = getAdaptiveCrf(crf, videoInfo);
                } catch {}

                result = await compressVideo(file.path, outputPath, {
                    encoder,
                    crf: adaptiveCrf,
                    threads: THREADS_PER_VIDEO,
                    originalSize,
                    skipDirCheck: true,
                    videoInfo,
                    signal: currentJobAbortController?.signal,
                    shouldCancel: () => compressionState.shouldCancel,
                    onStart: (cmd) => {
                        activeCmd = cmd;
                        activeFfmpegProcesses.add(cmd);
                    },
                    onProgress: (progress) => {
                        sendFileProgress(index, progress.percent || 0);
                    }
                });
            }

            if (!renameOnly) {
                await setFileMetadataAsync(file.path, outputPath, inputStat);
            }

            markProcessedForResume(file.path);

            sendSSE('file-complete', {
                index,
                savings: result.savings,
                originalSize: result.originalSize,
                compressedSize: result.compressedSize
            });

            return { success: true, result };
        } catch (error) {
            if (error?.cancelled || compressionState.shouldCancel) {
                await fs.promises.unlink(outputPath).catch(() => {});
                return { cancelled: true };
            }

            const errorMsg = error?.error || error?.message || JSON.stringify(error);
            console.error(`\n❌ COMPRESSION FAILED: ${file.name}`);
            console.error(`   Input: ${file.path}`);
            console.error(`   Output: ${outputPath}`);
            console.error(`   Error: ${errorMsg}`);

            if (file.type === 'video' || inputStat.size === 0) {
                await fs.promises.unlink(outputPath).catch(() => {});
            } else {
                try {
                    await fs.promises.copyFile(file.path, outputPath);
                    await setFileMetadataAsync(file.path, outputPath, inputStat);
                } catch {}
            }

            sendSSE('file-error', { index, error: errorMsg || 'Unknown error', file: file.name, path: file.path });

            compressionState.failedFiles.push({
                path: file.path,
                baseDir: file.baseDir,
                name: file.name,
                type: file.type,
                size: file.size,
                sizeFormatted: file.sizeFormatted,
                error: errorMsg || 'Unknown error',
                index
            });

            return { success: false };
        } finally {
            if (activeCmd) activeFfmpegProcesses.delete(activeCmd);
            if (file.type === 'video') evictProbeCache(file.path);
        }
    }

    async function runPool(items, concurrency) {
        if (items.length === 0) return;
        await parallelProcess(
            items,
            async (item) => {
                const res = await processSingleFile(item.file, item.index);
                if (!res || res.cancelled || res.skipped) return;

                compressionState.processed++;
                if (res.success) {
                    compressionState.results.success++;
                    compressionState.results.totalOriginal += res.result.originalSize;
                    compressionState.results.totalCompressed += res.result.compressedSize;
                } else {
                    compressionState.results.failed++;
                }

                sendSSE('overall-progress', {
                    processed: compressionState.processed,
                    total: compressionState.total,
                    percent: (compressionState.processed / compressionState.total) * 100
                });
            },
            concurrency,
            {
                collectResults: false,
                shouldCancel: () => compressionState.shouldCancel
            }
        );
    }

    try {
        if (overlapPools) {
            console.log(`   Overlapping image and video pools (${encoderConfig.type} is hardware accelerated)`);
            await Promise.all([
                runPool(images, IMAGE_CONCURRENCY),
                runPool(videos, VIDEO_CONCURRENCY)
            ]);
        } else {
            await runPool(images, IMAGE_CONCURRENCY);
            await runPool(videos, VIDEO_CONCURRENCY);
        }
    } finally {
        currentJobAbortController = null;
        await shutdownHeicPool().catch(() => {});
    }

    compressionState.results.endTime = Date.now();
    compressionState.results.duration = (compressionState.results.endTime - compressionState.results.startTime) / 1000;
    compressionState.results.totalSaved = compressionState.results.totalOriginal - compressionState.results.totalCompressed;
    compressionState.results.failedCount = compressionState.failedFiles.length;

    if (compressionState.shouldCancel) {
        if (jobMeta) {
            const remaining = baseFilesForResume.filter(f => !completedPaths.has(f.path));
            if (remaining.length > 0) {
                await writeJobStateNow({ ...jobMeta, pendingFiles: remaining });
            } else {
                await clearJobState();
            }
        }
        sendSSE('cancelled', compressionState.results);
    } else {
        await clearJobState();
        sendSSE('complete', compressionState.results);
    }

    compressionState.isRunning = false;
}

// Cancel compression immediately
app.post('/api/cancel', (req, res) => {
    compressionState.shouldCancel = true;
    cleanupActiveProcesses();
    res.json({ status: 'cancelling' });
});

// Get failed files
app.get('/api/failed-files', (req, res) => {
    res.json({ failedFiles: compressionState.failedFiles || [] });
});

// Retry failed files (preserves original row indices and initializes compressionState cleanly)
app.post('/api/retry-failed', async (req, res) => {
    if (compressionState.isRunning) {
        return res.status(400).json({ error: 'Compression already in progress' });
    }

    let { failedFiles, outputFolder, inputFolder, encoder, imageFormat, quality, crf, flatten, renameOnly, categoryByYear, categoryByMonth } = req.body;

    if (!failedFiles || failedFiles.length === 0) {
        return res.status(400).json({ error: 'No files to retry' });
    }

    quality = validateQuality(quality);
    crf = validateCrf(crf);
    encoder = validateEncoder(encoder);
    imageFormat = validateImageFormat(imageFormat);

    clearCaptureDateCache();
    initializeJobState(failedFiles.length);

    res.json({ status: 'retry-started', total: failedFiles.length });

    processFiles(failedFiles, outputFolder, inputFolder, encoder, imageFormat, parseInt(quality, 10), parseInt(crf, 10), flatten, renameOnly, categoryByYear, categoryByMonth);
});

// Save preset
app.post('/api/presets', async (req, res) => {
    const { name, settings } = req.body;
    if (!name || !settings) {
        return res.status(400).json({ error: 'Name and settings required' });
    }

    await fs.promises.mkdir(PRESETS_DIR, { recursive: true });
    const presetPath = path.join(PRESETS_DIR, `${name.replace(/[^a-z0-9]/gi, '_')}.json`);
    await fs.promises.writeFile(presetPath, JSON.stringify({ name, settings, createdAt: new Date().toISOString() }, null, 2));
    res.json({ status: 'saved', path: presetPath });
});

// Load all presets
app.get('/api/presets', async (req, res) => {
    if (!fs.existsSync(PRESETS_DIR)) {
        return res.json([]);
    }

    const entries = await fs.promises.readdir(PRESETS_DIR);
    const presets = [];
    for (const f of entries) {
        if (!f.endsWith('.json')) continue;
        try {
            const raw = await fs.promises.readFile(path.join(PRESETS_DIR, f), 'utf8');
            presets.push(JSON.parse(raw));
        } catch {}
    }

    res.json(presets);
});

// Delete preset
app.delete('/api/presets/:name', async (req, res) => {
    const presetPath = path.join(PRESETS_DIR, `${req.params.name.replace(/[^a-z0-9]/gi, '_')}.json`);

    if (fs.existsSync(presetPath)) {
        await fs.promises.unlink(presetPath);
        res.json({ status: 'deleted' });
    } else {
        res.status(404).json({ error: 'Preset not found' });
    }
});

// Get job state for resume
app.get('/api/job-state', (req, res) => {
    const state = loadJobState();
    res.json(state || { hasJob: false });
});

// Clear job state
app.post('/api/job-state/clear', async (req, res) => {
    await clearJobState();
    res.json({ status: 'cleared' });
});

// Resume interrupted job (initializes compressionState cleanly)
app.post('/api/job-state/resume', async (req, res) => {
    const state = loadJobState();
    if (!state || !state.pendingFiles || state.pendingFiles.length === 0) {
        return res.status(400).json({ error: 'No resumable job found' });
    }

    if (compressionState.isRunning) {
        return res.status(400).json({ error: 'Compression already in progress' });
    }

    clearCaptureDateCache();
    initializeJobState(state.pendingFiles.length);

    res.json({
        status: 'resumed',
        total: state.pendingFiles.length,
        files: state.pendingFiles
    });

    processFiles(
        state.pendingFiles,
        state.outputFolder,
        state.inputFolder,
        validateEncoder(state.encoder),
        validateImageFormat(state.imageFormat),
        validateQuality(state.quality),
        validateCrf(state.crf),
        state.flatten,
        state.renameOnly,
        state.categoryByYear,
        state.categoryByMonth,
        state
    );
});

// Performance metrics
app.get('/api/metrics', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
        uptime: process.uptime(),
        memory: {
            rss: formatFileSize(memUsage.rss),
            heapUsed: formatFileSize(memUsage.heapUsed),
            heapTotal: formatFileSize(memUsage.heapTotal)
        },
        compressionState: {
            isRunning: compressionState.isRunning,
            processed: compressionState.processed,
            total: compressionState.total,
            failed: compressionState.failedFiles?.length || 0
        }
    });
});

// Get current status
app.get('/api/status', (req, res) => {
    res.json({
        isRunning: compressionState.isRunning,
        currentFile: compressionState.currentFile,
        progress: compressionState.progress,
        processed: compressionState.processed,
        total: compressionState.total
    });
});

// SSE endpoint for real-time updates
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.push(res);

    const removeClient = () => {
        sseClients = sseClients.filter(client => client !== res);
    };

    req.on('close', removeClient);
    res.on('error', removeClient);
    req.on('error', removeClient);
});

// ============ Start Server ============
function findAvailablePort(startPort, maxAttempts = 10) {
    return new Promise((resolve, reject) => {
        const net = require('net');
        let currentPort = startPort;
        let attempts = 0;

        function tryPort(port) {
            const server = net.createServer();
            server.listen(port, HOST, () => {
                server.close();
                resolve(port);
            });
            server.on('error', () => {
                attempts++;
                if (attempts >= maxAttempts) {
                    reject(new Error(`No available port found after ${maxAttempts} attempts`));
                } else {
                    currentPort++;
                    tryPort(currentPort);
                }
            });
        }

        tryPort(currentPort);
    });
}

const startServer = async () => {
    return new Promise((resolve, reject) => {
        findAvailablePort(BASE_PORT)
            .then((PORT) => {
                const server = app.listen(PORT, HOST, async () => {
                    logger.info(`\n🗜️  Media Compressor GUI`);
                    logger.info(`   Server running at: http://localhost:${PORT}`);
                    if (PORT !== BASE_PORT) {
                        logger.warn(`   Port ${BASE_PORT} was busy, using port ${PORT} instead`);
                    }

                    if (process.env.ELECTRON_APP) {
                        logger.info('   Running in Electron mode');
                    } else {
                        logger.info(`   Press Ctrl+C to stop\n`);
                        try {
                            const open = (await import('open')).default;
                            await open(`http://localhost:${PORT}`);
                        } catch {
                            logger.info(`   Open http://localhost:${PORT} in your browser`);
                        }
                    }
                    resolve({ server, port: PORT, cleanupActiveProcesses });
                });
            })
            .catch(reject);
    });
};

if (require.main === module) {
    startServer();
} else {
    module.exports = startServer();
}
