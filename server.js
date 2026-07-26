/**
 * Web Local GUI Server
 * Express server for Media Compressor GUI
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('./src/logger');

// Import compression modules
const { compressImage } = require('./src/imageCompressor');
const { compressVideo, detectAvailableEncoders, getAdaptiveCrf } = require('./src/videoCompressor');
const { getEncoderConfig } = require('./src/hwEncoder');
const { isImage, isVideo, getFilesRecursive, formatFileSize, setFileMetadata, getCaptureDate, formatDateForFilename, normalizeOutputExtension, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, validateQuality, validateCrf, validateImageFormat, validateEncoder, clearCaptureDateCache, setCaptureDateCached, getCaptureDateCached, getAvailableMemory, getRecommendedVideoConcurrency, isLowMemory, isAlreadyProcessed, probeVideo, ensureDirCached, clearCreatedDirCache } = require('./src/utils');

const app = express();
const BASE_PORT = process.env.PORT || 3847;
// The API scans and writes arbitrary filesystem paths with no authentication,
// so it must not be reachable from the network. Binding to all interfaces would
// hand any machine on the same Wi-Fi read/write access to this one.
// Override only if you understand that (e.g. HOST=0.0.0.0 on a trusted LAN).
const HOST = process.env.HOST || '127.0.0.1';

// Middleware
app.use(express.json({ limit: '50mb' })); // Increased limit for large file lists
app.use(express.static(path.join(__dirname, 'gui')));

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

// Job resume state
const JOB_STATE_FILE = path.join(__dirname, 'tmp_review', 'job-state.json');

function saveJobState(state) {
    try {
        const dir = path.dirname(JOB_STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(JOB_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        logger.warn('Failed to save job state:', err.message);
    }
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

function clearJobState() {
    try {
        if (fs.existsSync(JOB_STATE_FILE)) {
            fs.unlinkSync(JOB_STATE_FILE);
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
        // A client that reloaded the window may already be destroyed; writing
        // to it throws and would otherwise abort the file currently compressing.
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

// FFmpeg emits progress several times per second per video. Forwarding every
// tick floods the SSE stream and forces a DOM write per event in the browser,
// so per-file progress is rate limited to a visually indistinguishable cadence.
const PROGRESS_THROTTLE_MS = 250;
const progressThrottle = new Map();

function sendFileProgress(index, percent) {
    const now = Date.now();
    const last = progressThrottle.get(index);
    const rounded = Math.round(percent);

    if (last) {
        // Nothing new to show.
        if (rounded === last.percent) return;
        // Let 100% through immediately so the row settles at full.
        if (rounded < 100 && now - last.at < PROGRESS_THROTTLE_MS) return;
    }

    progressThrottle.set(index, { at: now, percent: rounded });
    sendSSE('file-progress', { index, percent: rounded });
}

// ============ API Routes ============

// Get available encoders
app.get('/api/encoders', async (req, res) => {
    try {
        const encoders = await detectAvailableEncoders();
        res.json(encoders);
    } catch (error) {
        res.json({ nvenc: false, qsv: false, cpu: true });
    }
});

// Scan folder for media files
app.post('/api/scan', (req, res) => {
    const { folderPath, recursive, fileType } = req.body;

    if (!folderPath || !fs.existsSync(folderPath)) {
        return res.status(400).json({ error: 'Invalid folder path' });
    }

    try {
        // Build filter based on fileType
        let filter;
        if (fileType === 'image') {
            filter = (f) => isImage(f);
        } else if (fileType === 'video') {
            filter = (f) => isVideo(f);
        } else {
            filter = (f) => isImage(f) || isVideo(f);
        }

        let files;
        if (recursive) {
            files = getFilesRecursive(folderPath, filter);
        } else {
            files = fs.readdirSync(folderPath)
                .map(f => path.join(folderPath, f))
                .filter(f => {
                    try {
                        return fs.statSync(f).isFile() && filter(f);
                    } catch { return false; }
                });
        }

        const result = files.map(f => {
            const stats = fs.statSync(f);
            return {
                path: f,
                name: path.basename(f),
                type: isImage(f) ? 'image' : 'video',
                size: stats.size,
                sizeFormatted: formatFileSize(stats.size)
            };
        });

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Scan explicit file or directory paths for media files. Used by desktop drag-and-drop.
app.post('/api/scan-files', (req, res) => {
    const { filePaths, recursive, fileType } = req.body;

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return res.status(400).json({ error: 'No file paths provided' });
    }

    try {
        const filter = (filePath) => {
            if (fileType === 'image') return isImage(filePath);
            if (fileType === 'video') return isVideo(filePath);
            return isImage(filePath) || isVideo(filePath);
        };

        const seen = new Set();
        const result = [];

        const addFile = (filePath, baseDir) => {
            if (!filePath || seen.has(filePath) || !fs.existsSync(filePath)) return;

            const stats = fs.statSync(filePath);
            if (!stats.isFile() || !filter(filePath)) return;

            seen.add(filePath);
            result.push({
                path: filePath,
                baseDir,
                name: path.basename(filePath),
                type: isImage(filePath) ? 'image' : 'video',
                size: stats.size,
                sizeFormatted: formatFileSize(stats.size)
            });
        };

        for (const rawPath of filePaths) {
            if (!rawPath || !fs.existsSync(rawPath)) continue;

            const filePath = path.resolve(rawPath);
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
                const files = recursive
                    ? getFilesRecursive(filePath, filter)
                    : fs.readdirSync(filePath)
                        .map(f => path.join(filePath, f))
                        .filter(f => {
                            try {
                                return fs.statSync(f).isFile() && filter(f);
                            } catch { return false; }
                        });

                files.forEach(file => addFile(file, filePath));
            } else {
                addFile(filePath, path.dirname(filePath));
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

    // Validate and normalize inputs
    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files to compress' });
    }

    quality = validateQuality(quality);
    crf = validateCrf(crf);
    encoder = validateEncoder(encoder);
    imageFormat = validateImageFormat(imageFormat);

    // Ensure output folder exists
    if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder, { recursive: true });
    }

    // Clear cache and start compression
    clearCaptureDateCache();

    // Save job state for resume
    saveJobState({
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
    });

    // Start compression
    compressionState = {
        isRunning: true,
        shouldCancel: false,
        currentFile: null,
        progress: 0,
        processed: 0,
        total: files.length,
        failedFiles: [],
        results: {
            success: 0,
            failed: 0,
            totalOriginal: 0,
            totalCompressed: 0,
            startTime: Date.now()
        }
    };

    res.json({ status: 'started', total: files.length });

    // Process files
    processFiles(files, outputFolder, inputFolder, encoder, imageFormat, parseInt(quality), parseInt(crf), flatten, renameOnly, categoryByYear, categoryByMonth);
});

async function processFiles(files, outputFolder, inputFolder, encoder, imageFormat, quality, crf, flatten, renameOnly, categoryByYear, categoryByMonth) {
    // Dynamic concurrency based on CPU cores AND available memory
    const os = require('os');
    const cpuCount = os.cpus().length;
    const freeMem = getAvailableMemory();

    // Images: Use most cores (they're fast, low memory ~50MB per worker)
    const IMAGE_CONCURRENCY = Math.max(4, Math.min(cpuCount, 12));

    // Videos: Consider both CPU and memory (~2GB per worker)
    // Use lower of CPU-limited or memory-limited concurrency
    const VIDEO_CONCURRENCY = getRecommendedVideoConcurrency(files.length);

    // Threads for decoding/preprocessing (GPU handles encoding)
    let THREADS_PER_VIDEO = Math.max(2, Math.floor(cpuCount / VIDEO_CONCURRENCY));

    const memGB = (freeMem / (1024 * 1024 * 1024)).toFixed(1);
    console.log(`⚡ Dynamic concurrency: ${IMAGE_CONCURRENCY} images, ${VIDEO_CONCURRENCY} videos`);
    console.log(`   CPU: ${cpuCount} cores | RAM: ${memGB}GB free | Video workers: ${VIDEO_CONCURRENCY}`);

    const reservedOutputPaths = new Set();
    progressThrottle.clear();
    // Retry and resume reach this function without going through /api/compress,
    // so reset the per-job caches here rather than at the endpoint. A folder
    // deleted between runs must not stay marked as created.
    clearCreatedDirCache();

    // Check for low memory warning
    if (isLowMemory()) {
        console.log(`   ⚠️  LOW MEMORY WARNING - reduced concurrency`);
    }

    // Helper to process a single file
    async function processSingleFile(file, index) {
        if (compressionState.shouldCancel) return null;

        // Get capture date (falls back to file modified date)
        let captureDate = null;
        let yearFolder = null;
        try {
            captureDate = await getCaptureDate(file.path);
        } catch {
            // Use file mtime as last resort
            try {
                const stats = fs.statSync(file.path);
                captureDate = stats.mtime;
            } catch { }
        }

        // Generate new filename based on date
        const ext = path.extname(file.path);
        const extLower = ext.toLowerCase();

        // Use normalizeOutputExtension to determine output format
        let tempOutputPath = normalizeOutputExtension(file.path, imageFormat);
        let outputExt = path.extname(tempOutputPath);

        let newFilename;
        if (captureDate) {
            const baseName = formatDateForFilename(captureDate);
            newFilename = baseName + outputExt;
            yearFolder = captureDate.getFullYear().toString();
        } else {
            // No date available, keep original name but still apply normalization
            const originalName = path.basename(file.path, ext);
            newFilename = originalName + outputExt;
            yearFolder = 'other';
        }

        // Calculate output path based on options
        let outputPath;

        if (flatten) {
            // FLATTEN: All files go directly to output folder (no subfolders)
            outputPath = path.join(outputFolder, newFilename);
        } else if (categoryByYear || categoryByMonth) {
            // CATEGORY: Organize by Year and/or Month
            let parts = [outputFolder];

            // 1. Add Year Folder if selected
            if (categoryByYear && yearFolder && yearFolder !== 'other') {
                parts.push(yearFolder);
            }

            // 2. Add Month Folder if selected (format: YYYYMM__)
            if (categoryByMonth && captureDate) {
                const pad = (num) => String(num).padStart(2, '0');
                const monthStr = pad(captureDate.getMonth() + 1);
                const yearPrefix = captureDate.getFullYear().toString();
                const monthFolder = `${yearPrefix}${monthStr}__`;
                parts.push(monthFolder);
            }

            // 3. Add Filename
            parts.push(newFilename);
            outputPath = path.join(...parts);
        } else {
            // PRESERVE: Keep original subfolder structure
            const relativeRoot = file.baseDir || inputFolder;
            let relativePath = path.relative(relativeRoot, file.path);
            if (!relativeRoot || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                relativePath = path.basename(file.path);
            }
            const relativeDir = path.dirname(relativePath);
            outputPath = path.join(outputFolder, relativeDir, newFilename);
        }

        const inputStat = fs.statSync(file.path);
        const originalSize = inputStat.size;
        const baseOutputPath = outputPath;
        const baseNoExt = newFilename.slice(0, -outputExt.length);
        let counter = 0;

        // This loop is fully synchronous, so the reservation below is atomic
        // with respect to the other workers sharing reservedOutputPaths.
        while (true) {
            const candidatePath = counter === 0
                ? baseOutputPath
                : path.join(path.dirname(baseOutputPath), `${baseNoExt}_${counter}${outputExt}`);

            if (reservedOutputPaths.has(candidatePath)) {
                counter++;
                continue;
            }

            // One stat answers both "does it exist" and "is it already
            // processed", instead of the three blocking syscalls it used to take.
            let outputStat = null;
            try {
                outputStat = fs.statSync(candidatePath);
            } catch { }

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
                sendSSE('file-skipped', { index, name: file.name, sizeSaved: originalSize - outputStat.size });
                sendSSE('overall-progress', {
                    processed: compressionState.processed,
                    total: compressionState.total,
                    percent: (compressionState.processed / compressionState.total) * 100
                });
                return;
            }

            counter++;
        }

        // Ensure parent directory exists
        ensureDirCached(path.dirname(outputPath));

        sendSSE('file-start', { index, name: file.name, type: file.type });

        try {
            let result;

            if (renameOnly) {
                // HEIC/HEIF files must be converted even in renameOnly mode
                // because HEIC binary format must be decoded to the target format (WebP/JPEG/AVIF)
                if (extLower === '.heic' || extLower === '.heif') {
                    result = await compressImage(file.path, outputPath, { quality });
                    result.savings = 'Converted from HEIC';
                } else {
                    // Other formats: just copy with new extension
                    fs.copyFileSync(file.path, outputPath);
                    setFileMetadata(file.path, outputPath);
                    result = {
                        originalSize: originalSize,
                        compressedSize: originalSize,
                        savings: 'Renamed only'
                    };
                }
            } else if (file.type === 'image') {
                result = await compressImage(file.path, outputPath, { quality });
            } else {
                // Get video info for adaptive CRF. probeVideo reuses the ffprobe
                // result already fetched when resolving this file's capture date.
                let adaptiveCrf = crf;
                try {
                    const videoInfo = await probeVideo(file.path);
                    if (videoInfo) adaptiveCrf = getAdaptiveCrf(crf, videoInfo);
                } catch {}

                result = await compressVideo(file.path, outputPath, {
                    encoder: encoder,
                    crf: adaptiveCrf,
                    threads: THREADS_PER_VIDEO,
                    shouldCancel: () => compressionState.shouldCancel,
                    onProgress: (progress) => {
                        sendFileProgress(index, progress.percent || 0);
                    }
                });
            }

            if (!renameOnly) {
                setFileMetadata(file.path, outputPath);
            }

            sendSSE('file-complete', {
                index,
                savings: result.savings,
                originalSize: result.originalSize,
                compressedSize: result.compressedSize
            });

            return { success: true, result };
        } catch (error) {
            // Log detailed error for debugging
            // Error might be an object with 'error' property from videoCompressor
            const errorMsg = error?.error || error?.message || JSON.stringify(error);
            console.error(`\n❌ COMPRESSION FAILED: ${file.name}`);
            console.error(`   Input: ${file.path}`);
            console.error(`   Output: ${outputPath}`);
            console.error(`   Error: ${errorMsg}`);

            // For video files being converted, don't copy original (incompatible codec)
            // Also clean up any partial output file that FFmpeg may have created
            if (file.type === 'video') {
                try {
                    if (fs.existsSync(outputPath)) {
                        fs.unlinkSync(outputPath);
                        console.error(`   Cleaned up partial file`);
                    }
                } catch { }
            } else {
                // For image files, try to copy original as fallback
                try {
                    fs.copyFileSync(file.path, outputPath);
                    setFileMetadata(file.path, outputPath);
                } catch { }
            }
            // errorMsg, not error.message: compressVideo rejects with a plain
            // object carrying `error`, so error.message is undefined and every
            // video failure would otherwise surface as "Unknown error".
            sendSSE('file-error', { index, error: errorMsg || 'Unknown error', file: file.name, path: file.path });

            // Track failed file for retry
            compressionState.failedFiles.push({
                path: file.path,
                name: file.name,
                type: file.type,
                size: file.size,
                sizeFormatted: file.sizeFormatted,
                error: errorMsg || 'Unknown error',
                index
            });

            return { success: false };
        }
    }

    // Worker pool pattern: each slot immediately picks up the next item when done
    // This avoids the issue where fast items wait for slow items in the same batch
    async function processWithWorkerPool(items, concurrency) {
        const results = [];
        const executing = new Set();

        // Helper to process one item and update progress
        async function processItem(item) {
            const res = await processSingleFile(item.file, item.index);

            // Update progress immediately when each item completes
            if (res) {
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
            }

            return res;
        }

        for (const item of items) {
            if (compressionState.shouldCancel) break;

            // Create promise for this item
            const promise = processItem(item).then(result => {
                executing.delete(promise);
                return result;
            }).catch(error => {
                executing.delete(promise);
                return { success: false, error };
            });

            results.push(promise);
            executing.add(promise);

            // If we've reached max concurrency, wait for ANY one to complete
            // This is the key difference from batch processing!
            if (executing.size >= concurrency) {
                await Promise.race(executing);
            }
        }

        // Wait for all remaining items to complete
        return Promise.all(results);
    }

    // Separate images and videos with their original indices
    const images = [];
    const videos = [];
    files.forEach((file, index) => {
        if (file.type === 'image') {
            images.push({ file, index });
        } else {
            videos.push({ file, index });
        }
    });

    console.log(`Processing ${images.length} images (${IMAGE_CONCURRENCY} concurrent) and ${videos.length} videos (${VIDEO_CONCURRENCY} concurrent)`);

    // Images are CPU-bound (Sharp) while GPU encoders are mostly idle waiting on
    // the encode ASIC, so the two pools can overlap and finish in the time the
    // slower one alone would take. Software encoders compete for the same cores,
    // so those stay sequential.
    let usesHardwareEncoder = false;
    try {
        const encoderConfig = await getEncoderConfig(encoder);
        usesHardwareEncoder = ['nvenc', 'amf', 'qsv'].includes(encoderConfig.type);
    } catch { }

    if (usesHardwareEncoder && images.length > 0 && videos.length > 0) {
        console.log(`   Overlapping image and video pools (${encoder} is hardware accelerated)`);
        // Both pools now share the CPU, so leave headroom for the image workers.
        THREADS_PER_VIDEO = Math.max(1, Math.floor(THREADS_PER_VIDEO / 2));
        await Promise.all([
            processWithWorkerPool(images, IMAGE_CONCURRENCY),
            processWithWorkerPool(videos, VIDEO_CONCURRENCY)
        ]);
    } else {
        // Process images first (faster, more parallelizable) using worker pool
        await processWithWorkerPool(images, IMAGE_CONCURRENCY);

        // Then process videos using worker pool
        await processWithWorkerPool(videos, VIDEO_CONCURRENCY);
    }

    // Done
    compressionState.results.endTime = Date.now();
    compressionState.results.duration = (compressionState.results.endTime - compressionState.results.startTime) / 1000;
    compressionState.results.totalSaved = compressionState.results.totalOriginal - compressionState.results.totalCompressed;
    compressionState.results.failedCount = compressionState.failedFiles.length;

    // Clear job state on completion
    clearJobState();

    if (compressionState.shouldCancel) {
        sendSSE('cancelled', compressionState.results);
    } else {
        sendSSE('complete', compressionState.results);
    }
    compressionState.isRunning = false;
}

// Cancel compression
app.post('/api/cancel', (req, res) => {
    compressionState.shouldCancel = true;
    res.json({ status: 'cancelling' });
});

// Get failed files
app.get('/api/failed-files', (req, res) => {
    res.json({ failedFiles: compressionState.failedFiles || [] });
});

// Retry failed files
app.post('/api/retry-failed', async (req, res) => {
    if (compressionState.isRunning) {
        return res.status(400).json({ error: 'Compression already in progress' });
    }

    const { failedFiles, outputFolder, inputFolder, encoder, imageFormat, quality, crf, flatten, renameOnly, categoryByYear, categoryByMonth } = req.body;

    if (!failedFiles || failedFiles.length === 0) {
        return res.status(400).json({ error: 'No files to retry' });
    }

    compressionState.failedFiles = [];
    res.json({ status: 'retry-started', total: failedFiles.length });

    processFiles(failedFiles, outputFolder, inputFolder, encoder, imageFormat, parseInt(quality), parseInt(crf), flatten, renameOnly, categoryByYear, categoryByMonth);
});

// Save preset
app.post('/api/presets', (req, res) => {
    const { name, settings } = req.body;
    if (!name || !settings) {
        return res.status(400).json({ error: 'Name and settings required' });
    }

    const presetsDir = path.join(__dirname, 'presets');
    if (!fs.existsSync(presetsDir)) fs.mkdirSync(presetsDir, { recursive: true });

    const presetPath = path.join(presetsDir, `${name.replace(/[^a-z0-9]/gi, '_')}.json`);
    fs.writeFileSync(presetPath, JSON.stringify({ name, settings, createdAt: new Date().toISOString() }, null, 2));
    res.json({ status: 'saved', path: presetPath });
});

// Load all presets
app.get('/api/presets', (req, res) => {
    const presetsDir = path.join(__dirname, 'presets');
    if (!fs.existsSync(presetsDir)) {
        return res.json([]);
    }

    const presets = fs.readdirSync(presetsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            try {
                return JSON.parse(fs.readFileSync(path.join(presetsDir, f), 'utf8'));
            } catch {
                return null;
            }
        })
        .filter(Boolean);

    res.json(presets);
});

// Delete preset
app.delete('/api/presets/:name', (req, res) => {
    const presetsDir = path.join(__dirname, 'presets');
    const presetPath = path.join(presetsDir, `${req.params.name.replace(/[^a-z0-9]/gi, '_')}.json`);

    if (fs.existsSync(presetPath)) {
        fs.unlinkSync(presetPath);
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
app.post('/api/job-state/clear', (req, res) => {
    clearJobState();
    res.json({ status: 'cleared' });
});

// Resume job
app.post('/api/job-state/resume', async (req, res) => {
    const state = loadJobState();
    if (!state || !state.pendingFiles || state.pendingFiles.length === 0) {
        return res.status(400).json({ error: 'No resumable job found' });
    }

    if (compressionState.isRunning) {
        return res.status(400).json({ error: 'Compression already in progress' });
    }

    compressionState.failedFiles = [];
    res.json({ status: 'resumed', total: state.pendingFiles.length });

    processFiles(state.pendingFiles, state.outputFolder, state.inputFolder, state.encoder, state.imageFormat, state.quality, state.crf, state.flatten, state.renameOnly, state.categoryByYear, state.categoryByMonth);
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
    // Without this handler a socket reset (window reload mid-compression)
    // surfaces as an unhandled 'error' event and takes the process down.
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
                        } catch (err) {
                            logger.info(`   Open http://localhost:${PORT} in your browser`);
                        }
                    }
                    resolve({ server, port: PORT });
                });
            })
            .catch(reject);
    });
};

// Start immediately if run directly
if (require.main === module) {
    startServer();
} else {
    // Export for Electron
    module.exports = startServer();
}
