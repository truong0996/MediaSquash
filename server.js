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
const { isImage, isVideo, getFilesRecursive, formatFileSize, setFileMetadata, getCaptureDate, formatDateForFilename } = require('./src/utils');

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
    const { files, outputFolder, inputFolder, encoder, quality, crf, flatten, renameOnly, categoryByYear } = req.body;

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
    processFiles(files, outputFolder, inputFolder, encoder, parseInt(quality), parseInt(crf), flatten, renameOnly, categoryByYear);
});

async function processFiles(files, outputFolder, inputFolder, encoder, quality, crf, flatten, renameOnly, categoryByYear) {
    // Dynamic concurrency based on CPU cores
    const os = require('os');
    const cpuCount = os.cpus().length;

    // Images: Use most cores (they're fast, low memory)
    // Videos: Use fewer (they use GPU and more memory)
    const IMAGE_CONCURRENCY = Math.max(4, Math.min(cpuCount, 12));  // 4-12 based on cores
    const VIDEO_CONCURRENCY = Math.max(1, Math.min(Math.floor(cpuCount / 4), 4)); // 1-4 based on cores

    console.log(`⚡ Dynamic concurrency: ${IMAGE_CONCURRENCY} images, ${VIDEO_CONCURRENCY} videos (${cpuCount} CPU cores detected)`);

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
        let newFilename;
        if (captureDate) {
            const baseName = formatDateForFilename(captureDate);
            newFilename = baseName + ext;
            yearFolder = captureDate.getFullYear().toString();
        } else {
            // No date available, keep original name
            newFilename = path.basename(file.path);
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
            const baseNoExt = newFilename.slice(0, -ext.length);
            while (fs.existsSync(outputPath)) {
                const uniqueName = `${baseNoExt}_${counter}${ext}`;
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
                fs.copyFileSync(file.path, outputPath);
                setFileMetadata(file.path, outputPath);
                result = {
                    originalSize: originalSize,
                    compressedSize: originalSize,
                    savings: 'Renamed only'
                };
            } else if (file.type === 'image') {
                result = await compressImage(file.path, outputPath, { quality });
            } else {
                result = await compressVideo(file.path, outputPath, {
                    encoder: encoder,
                    crf: crf,
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
            try {
                fs.copyFileSync(file.path, outputPath);
                setFileMetadata(file.path, outputPath);
            } catch { }
            sendSSE('file-error', { index, error: error.message || 'Unknown error' });
            return { success: false };
        }
    }

    // Helper to process batch with concurrency limit
    async function processBatch(items, concurrency) {
        const results = [];
        for (let i = 0; i < items.length; i += concurrency) {
            if (compressionState.shouldCancel) break;

            const batch = items.slice(i, i + concurrency);
            const batchResults = await Promise.all(
                batch.map(item => processSingleFile(item.file, item.index))
            );

            // Update progress after each batch
            for (const res of batchResults) {
                if (res) {
                    compressionState.processed++;
                    if (res.success) {
                        compressionState.results.success++;
                        compressionState.results.totalOriginal += res.result.originalSize;
                        compressionState.results.totalCompressed += res.result.compressedSize;
                    } else {
                        compressionState.results.failed++;
                    }
                }
            }

            sendSSE('overall-progress', {
                processed: compressionState.processed,
                total: compressionState.total,
                percent: (compressionState.processed / compressionState.total) * 100
            });

            results.push(...batchResults);
        }
        return results;
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

    // Process images first (faster, more parallelizable)
    await processBatch(images, IMAGE_CONCURRENCY);

    // Then process videos
    await processBatch(videos, VIDEO_CONCURRENCY);

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
app.listen(PORT, async () => {
    console.log(`\n🗜️  Media Compressor GUI`);
    console.log(`   Server running at: http://localhost:${PORT}`);
    console.log(`   Press Ctrl+C to stop\n`);

    // Auto-open browser
    try {
        const open = (await import('open')).default;
        await open(`http://localhost:${PORT}`);
    } catch (err) {
        console.log(`   Open http://localhost:${PORT} in your browser`);
    }
});
