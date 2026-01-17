/**
 * Web Local GUI Server
 * Express server for Media Compressor GUI
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

// Import compression modules
const { compressImage } = require('./src/imageCompressor');
const { compressVideo, detectAvailableEncoders } = require('./src/videoCompressor');
const { isImage, isVideo, getFilesRecursive, formatFileSize, setFileMetadata, getCaptureDate, formatDateForFilename, normalizeOutputExtension, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } = require('./src/utils');

const app = express();
const PORT = 3847; // Random port to avoid conflicts

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
    results: null
};

// SSE clients for real-time updates
let sseClients = [];

function sendSSE(event, data) {
    sseClients.forEach(client => {
        client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
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

// Start compression
app.post('/api/compress', async (req, res) => {
    const { files, outputFolder, inputFolder, encoder, imageFormat, quality, crf, flatten, renameOnly, categoryByYear } = req.body;

    if (compressionState.isRunning) {
        return res.status(400).json({ error: 'Compression already in progress' });
    }

    // Validate
    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files to compress' });
    }

    // Ensure output folder exists
    if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder, { recursive: true });
    }

    // Start compression in background
    compressionState = {
        isRunning: true,
        shouldCancel: false,
        currentFile: null,
        progress: 0,
        processed: 0,
        total: files.length,
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
    processFiles(files, outputFolder, inputFolder, encoder, imageFormat, parseInt(quality), parseInt(crf), flatten, renameOnly, categoryByYear);
});

async function processFiles(files, outputFolder, inputFolder, encoder, imageFormat, quality, crf, flatten, renameOnly, categoryByYear) {
    // Dynamic concurrency based on CPU cores
    const os = require('os');
    const cpuCount = os.cpus().length;

    // Images: Use most cores (they're fast, low memory)
    const IMAGE_CONCURRENCY = Math.max(4, Math.min(cpuCount, 12));  // 4-12 based on cores

    // Videos: Using GPU encoding (NVENC/QSV), so GPU does the heavy lifting
    // More workers = better throughput since CPU mainly decodes/feeds data
    // Scale based on CPU: small CPUs (8 threads) = 3-4 workers, large CPUs (16+ threads) = 6 workers
    const VIDEO_CONCURRENCY = Math.max(2, Math.min(6, Math.floor(cpuCount / 2)));

    // Threads for decoding/preprocessing (GPU handles encoding)
    // Each worker gets a fair share of CPU for decoding
    const THREADS_PER_VIDEO = Math.max(2, Math.floor(cpuCount / VIDEO_CONCURRENCY));

    console.log(`⚡ Dynamic concurrency: ${IMAGE_CONCURRENCY} images, ${VIDEO_CONCURRENCY} videos (${cpuCount} CPU cores detected)`);
    console.log(`   Video threads per worker: ${THREADS_PER_VIDEO} (GPU encoding, threads for decoding)`);

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
        if (flatten || categoryByYear) {
            if (categoryByYear && yearFolder) {
                outputPath = path.join(outputFolder, yearFolder, newFilename);
            } else {
                outputPath = path.join(outputFolder, newFilename);
            }
        } else {
            // Preserve subfolder structure but still rename file
            const relativePath = path.relative(inputFolder, file.path);
            const relativeDir = path.dirname(relativePath);
            outputPath = path.join(outputFolder, relativeDir, newFilename);
        }

        // Handle duplicate filenames by adding counter
        if (fs.existsSync(outputPath)) {
            let counter = 1;
            const baseNoExt = newFilename.slice(0, -outputExt.length);
            while (fs.existsSync(outputPath)) {
                const uniqueName = `${baseNoExt}_${counter}${outputExt}`;
                outputPath = path.join(path.dirname(outputPath), uniqueName);
                counter++;
            }
        }

        // Ensure parent directory exists
        const parentDir = path.dirname(outputPath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }

        sendSSE('file-start', { index, name: file.name, type: file.type });

        try {
            let result;
            const originalSize = fs.statSync(file.path).size;

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
                result = await compressVideo(file.path, outputPath, {
                    encoder: encoder,
                    crf: crf,
                    threads: THREADS_PER_VIDEO,  // Use calculated optimal threads
                    onProgress: (progress) => {
                        sendSSE('file-progress', { index, percent: progress.percent || 0 });
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
            sendSSE('file-error', { index, error: error.message || 'Unknown error' });
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

    // Process images first (faster, more parallelizable) using worker pool
    await processWithWorkerPool(images, IMAGE_CONCURRENCY);

    // Then process videos using worker pool
    await processWithWorkerPool(videos, VIDEO_CONCURRENCY);

    // Done
    compressionState.results.endTime = Date.now();
    compressionState.results.duration = (compressionState.results.endTime - compressionState.results.startTime) / 1000;
    compressionState.results.totalSaved = compressionState.results.totalOriginal - compressionState.results.totalCompressed;

    sendSSE('complete', compressionState.results);
    compressionState.isRunning = false;
}

// Cancel compression
app.post('/api/cancel', (req, res) => {
    compressionState.shouldCancel = true;
    res.json({ status: 'cancelling' });
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

    req.on('close', () => {
        sseClients = sseClients.filter(client => client !== res);
    });
});

// ============ Start Server ============
const startServer = async () => {
    return new Promise((resolve) => {
        const server = app.listen(PORT, async () => {
            console.log(`\n🗜️  Media Compressor GUI`);
            console.log(`   Server running at: http://localhost:${PORT}`);

            if (process.env.ELECTRON_APP) {
                console.log('   Running in Electron mode');
            } else {
                console.log(`   Press Ctrl+C to stop\n`);
                // Auto-open browser only if NOT in Electron
                try {
                    const open = (await import('open')).default;
                    await open(`http://localhost:${PORT}`);
                } catch (err) {
                    console.log(`   Open http://localhost:${PORT} in your browser`);
                }
            }
            resolve(server);
        });
    });
};

// Start immediately if run directly
if (require.main === module) {
    startServer();
} else {
    // Export for Electron
    module.exports = startServer();
}
