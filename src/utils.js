const path = require('path');
const fs = require('fs');
const os = require('os');

// Supported file extensions
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tiff', '.gif', '.heic', '.heif'];
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.3gp', '.m4v', '.mpeg', '.mpg'];

/**
 * Normalize output file extension for consistent format
 * Images → .webp (default), .jpeg, or .avif | Videos → .mp4
 * @param {string} filePath - File path to normalize
 * @returns {string} - Normalized file path with consistent extension
 */
function normalizeOutputExtension(filePath, imageFormat = 'webp') {
    const ext = path.extname(filePath).toLowerCase();
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));

    // Normalize image extensions to target format
    if (IMAGE_EXTENSIONS.includes(ext)) {
        const targetExt = imageFormat.startsWith('.') ? imageFormat : `.${imageFormat}`;
        return path.join(dir, `${baseName}${targetExt}`);
    }

    // Normalize video extensions to .mp4
    if (VIDEO_EXTENSIONS.includes(ext)) {
        return path.join(dir, `${baseName}.mp4`);
    }

    // Return as-is for other files
    return filePath;
}

/**
 * Get optimal concurrency based on CPU cores
 * Uses half the cores to keep system responsive
 * @returns {number}
 */
function getOptimalConcurrency() {
    const cpuCount = os.cpus().length;
    // Use half the cores (minimum 1, maximum 8) to keep system responsive
    return Math.max(1, Math.min(Math.floor(cpuCount / 2), 8));
}

/**
 * Get number of threads for FFmpeg based on CPU cores
 * @returns {number}
 */
function getOptimalThreads() {
    const cpuCount = os.cpus().length;
    // Use cores - 1 to leave some headroom, minimum 1
    return Math.max(1, cpuCount - 1);
}

/**
 * Get available system memory in bytes
 * @returns {number}
 */
function getAvailableMemory() {
    try {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        return freeMem;
    } catch {
        return 0;
    }
}

/**
 * Get recommended video concurrency based on available memory
 * Video encoding uses ~1-4GB RAM per worker
 * @param {number} videoCount - Number of videos to process
 * @returns {number}
 */
function getRecommendedVideoConcurrency(videoCount) {
    const cpuCount = os.cpus().length;
    const freeMem = getAvailableMemory();

    // Default: use half CPU, 2GB per video worker
    let maxByCpu = Math.max(1, Math.min(Math.floor(cpuCount / 2), 6));
    let maxByMem = Math.max(1, Math.floor(freeMem / (2 * 1024 * 1024 * 1024)));

    // Use the lower of CPU and memory constraints
    let recommended = Math.min(maxByCpu, maxByMem, videoCount);

    return Math.max(1, recommended);
}

/**
 * Check if system is low on memory (below 1GB free)
 * @returns {boolean}
 */
function isLowMemory() {
    const freeMem = getAvailableMemory();
    return freeMem < 1024 * 1024 * 1024; // 1GB
}

/**
 * Check if a file has already been processed
 * Returns true if output exists and is newer than input (or same size for lossless)
 * @param {string} inputPath - Input file path
 * @param {string} outputPath - Output file path
 * @returns {boolean}
 */
function isAlreadyProcessed(inputPath, outputPath) {
    try {
        if (!fs.existsSync(outputPath)) return false;

        const inputStat = fs.statSync(inputPath);
        const outputStat = fs.statSync(outputPath);

        // Output is newer than input
        if (outputStat.mtime > inputStat.mtime) {
            // If output is significantly smaller, consider it processed
            if (outputStat.size < inputStat.size) return true;
            // If same size but newer, likely re-compressed (not a lossless case)
            return true;
        }
    } catch {}
    return false;
}

/**
 * Process items in parallel with concurrency limit
 * @param {Array} items - Items to process
 * @param {Function} processor - Async function to process each item
 * @param {number} concurrency - Maximum concurrent operations
 * @returns {Promise<Array>} - Results
 */
async function parallelProcess(items, processor, concurrency) {
    const results = [];
    const executing = new Set();

    for (const item of items) {
        const promise = processor(item).then(result => {
            executing.delete(promise);
            return result;
        }).catch(error => {
            executing.delete(promise);
            return { error, item };
        });

        results.push(promise);
        executing.add(promise);

        if (executing.size >= concurrency) {
            await Promise.race(executing);
        }
    }

    return Promise.all(results);
}

/**
 * Check if a file is an image based on extension
 * @param {string} filePath - Path to the file
 * @returns {boolean}
 */
function isImage(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Check if a file is a video based on extension
 * @param {string} filePath - Path to the file
 * @returns {boolean}
 */
function isVideo(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Get file size in human-readable format
 * @param {number} bytes - File size in bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Get file size in bytes
 * @param {string} filePath - Path to the file
 * @returns {number}
 */
function getFileSize(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return stats.size;
    } catch {
        return 0;
    }
}

/**
 * Calculate compression ratio
 * @param {number} originalSize - Original file size in bytes
 * @param {number} compressedSize - Compressed file size in bytes
 * @returns {string}
 */
function getCompressionRatio(originalSize, compressedSize) {
    if (originalSize === 0) return '0%';
    const ratio = ((originalSize - compressedSize) / originalSize) * 100;
    return ratio.toFixed(2) + '%';
}

/**
 * Ensure output directory exists
 * @param {string} filePath - Path to file (will create parent directory)
 */
function ensureDirectoryExists(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Generate output file path
 * @param {string} inputPath - Input file path
 * @param {string} outputPath - Output path (file or directory)
 * @param {string} suffix - Optional suffix to add before extension
 * @returns {string}
 */
function generateOutputPath(inputPath, outputPath, suffix = '') {
    if (!outputPath) {
        // No output specified, add suffix to original filename
        const ext = path.extname(inputPath);
        const base = path.basename(inputPath, ext);
        const dir = path.dirname(inputPath);
        return path.join(dir, `${base}${suffix || '_compressed'}${ext}`);
    }

    // Check if output is a directory
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
        const filename = path.basename(inputPath);
        return path.join(outputPath, filename);
    }

    return outputPath;
}

/**
 * Get all files in a directory recursively
 * @param {string} dir - Directory to search
 * @param {Function} filter - Filter function for files
 * @returns {string[]} - Array of absolute file paths
 */
function getFilesRecursive(dir, filter) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        file = path.join(dir, file);
        let stat;
        try {
            stat = fs.statSync(file);
        } catch (e) { return; }

        if (stat && stat.isDirectory()) {
            results = results.concat(getFilesRecursive(file, filter));
        } else {
            if (!filter || filter(file)) {
                results.push(file);
            }
        }
    });
    return results;
}

const sharp = require('sharp');
const exifReader = require('exif-reader');
const ffmpeg = require('fluent-ffmpeg');
const ffprobe = require('ffprobe-static');

// Set ffprobe path once (with Electron fix)
let ffprobePath = ffprobe.path;
if (ffprobePath && ffprobePath.includes('app.asar')) {
    ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');
}
ffmpeg.setFfprobePath(ffprobePath);

// Helper to find Google Takeout JSON sidecar with fuzzy matching
function findJsonSidecar(filePath) {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const extension = path.extname(filePath);
    const baseName = path.basename(filePath, extension);

    const exactCandidates = [
        filePath + '.json',
        filePath + '.supplemental-metadata.json'
    ];
    for (const exact of exactCandidates) {
        if (fs.existsSync(exact)) return exact;
    }

    try {
        const files = fs.readdirSync(dir);
        const jsonFiles = files.filter(f => f.toLowerCase().endsWith('.json'));

        let bestMatch = null;
        let bestMatchLen = 0;

        for (const jsonFile of jsonFiles) {
            const jsonPath = path.join(dir, jsonFile);
            const jsonBase = path.basename(jsonFile, '.json');

            if (jsonFile.startsWith(fileName)) {
                if (jsonFile.length > bestMatchLen) {
                    bestMatch = jsonPath;
                    bestMatchLen = jsonFile.length;
                }
                continue;
            }

            if (baseName.startsWith(jsonBase)) {
                if (jsonBase.length >= 8) {
                    if (jsonFile.length > bestMatchLen) {
                        bestMatch = jsonPath;
                        bestMatchLen = jsonFile.length;
                    }
                }
            }
        }

        return bestMatch;

    } catch (e) {
        // ignore read errors
    }
    return null;
}

/**
 * Get capture date from metadata
 * @param {string} filePath
 * @returns {Promise<Date|null>}
 */
async function getCaptureDate(filePath) {
    // Helper: Convert absolute timestamp to "Fake UTC" so that getUTC methods return Local time.
    // e.g. If local is 19:00 and UTC is 12:00, this shifts 12:00 -> 19:00 (still labeled UTC).
    // This allows formatDateForFilename to print "1900" using getUTC methods.
    const toLocalAsUTC = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000);

    // --- Google Takeout JSON (Has Priority) ---
    const jsonPath = findJsonSidecar(filePath);
    if (jsonPath) {
        try {
            const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            if (jsonContent.photoTakenTime && jsonContent.photoTakenTime.timestamp) {
                const timestamp = parseInt(jsonContent.photoTakenTime.timestamp, 10) * 1000;
                if (!isNaN(timestamp)) {
                    // Google timestamps are real UTC. Shift to local.
                    return toLocalAsUTC(new Date(timestamp));
                }
            }
        } catch (err) {
        }
    }

    // --- IMAGES ---
    if (isImage(filePath)) {
        try {
            const metadata = await sharp(filePath).metadata();
            if (metadata.exif) {
                const exif = exifReader(metadata.exif);
                const exifDate = exif.Photo?.DateTimeOriginal || exif.Image?.DateTime;
                if (exifDate) {
                    return new Date(exifDate);
                }
            }
        } catch (err) {
        }

        try {
            const stats = fs.statSync(filePath);
            return toLocalAsUTC(stats.mtime);
        } catch {
            return null;
        }
    }

    // --- VIDEOS ---
    if (isVideo(filePath)) {
        let metadataDate = null;
        let mtimeDate = null;

        try {
            metadataDate = await new Promise((resolve) => {
                ffmpeg.ffprobe(filePath, (err, metadata) => {
                    if (err) {
                        resolve(null);
                        return;
                    }

                    // Priority list for video creation time tags
                    // 1. Apple-specific high-precision tags
                    // 2. Standard creation_time
                    const tags = metadata.format?.tags || {};
                    const creationTime =
                        tags['com.apple.quicktime.creationdate'] ||
                        tags['creation_date'] ||
                        tags['creation_time'] ||
                        metadata.streams?.find(s => s.tags?.creation_time)?.tags?.creation_time;

                    if (creationTime) {
                        // Video metadata is almost exclusively stored in UTC (e.g., MP4 spec).
                        // However, com.apple.quicktime.creationdate often includes an offset (e.g. 2023-10-14T15:30:45+0700).
                        // Date constructor handles both.
                        const dateObj = new Date(creationTime);
                        if (!isNaN(dateObj.getTime())) {
                            // If it's a standard UTC string without offset, we shift it to local.
                            // If it already had an offset, new Date() converted it to local machine time.
                            // But we want "Fake UTC" for formatDateForFilename.

                            // Check if the source string had an offset
                            const hasOffset = creationTime.includes('+') || (creationTime.match(/-/g) || []).length > 2;

                            if (hasOffset) {
                                // Already local time in dateObj, just shift to Fake UTC
                                resolve(toLocalAsUTC(dateObj));
                            } else {
                                // Likely UTC (Z or no offset), shift to local
                                resolve(toLocalAsUTC(dateObj));
                            }
                            return;
                        }
                    }
                    resolve(null);
                });
            });
        } catch {
        }

        // --- SIBLING FALLBACK (For Live Photos) ---
        // If metadata extraction failed, check for a companion image file (HEIC or JPG)
        if (!metadataDate) {
            const dir = path.dirname(filePath);
            const ext = path.extname(filePath);
            const baseName = path.basename(filePath, ext);

            const imageCandidates = ['.heic', '.heif', '.jpg', '.jpeg', '.png'];
            for (const imgExt of imageCandidates) {
                const siblingPath = path.join(dir, baseName + imgExt);
                if (fs.existsSync(siblingPath)) {
                    // Try to get date from sibling image
                    const siblingDate = await getCaptureDate(siblingPath);
                    if (siblingDate) {
                        metadataDate = siblingDate;
                        break;
                    }
                }
            }
        }

        try {
            const stats = fs.statSync(filePath);
            mtimeDate = toLocalAsUTC(stats.mtime);
        } catch {
        }

        // Use Metadata if available (shifted to local), otherwise file system mtime
        if (metadataDate) {
            return metadataDate;
        } else if (mtimeDate) {
            return mtimeDate;
        }

        return null;
    }

    return null;
}

function formatDateForFilename(date) {
    if (!date || isNaN(date.getTime())) return 'unknown';

    const pad = (num) => String(num).padStart(2, '0');
    // We use UTC methods here because the date objects have been shifted 
    // ("faked") to contain local time values in their UTC slots.
    const year = date.getUTCFullYear();
    const month = pad(date.getUTCMonth() + 1);
    const day = pad(date.getUTCDate());
    const hours = pad(date.getUTCHours());
    const minutes = pad(date.getUTCMinutes());
    const seconds = pad(date.getUTCSeconds());

    return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

// Format date for folder structure (YYYY-MM)
function formatDateForFolder(date) {
    if (!date || isNaN(date.getTime())) return 'Unknown_Date';
    const pad = (num) => String(num).padStart(2, '0');
    const year = date.getUTCFullYear();
    const month = pad(date.getUTCMonth() + 1);
    return `${year}-${month}`;
}

/**
 * Preserve file metadata (birthtime and mtime)
 * @param {string} sourcePath - Path to original file
 * @param {string} targetPath - Path to new file
 */
function setFileMetadata(sourcePath, targetPath) {
    try {
        const stats = fs.statSync(sourcePath);
        fs.utimesSync(targetPath, stats.atime, stats.mtime);
    } catch {
    }
}

/**
 * Get corrected FFmpeg path for Electron environment
 * @returns {string}
 */
function getFFmpegPath() {
    let ffmpegPath;
    try {
        ffmpegPath = require('ffmpeg-static');
    } catch {
        ffmpegPath = 'ffmpeg';
    }

    if (ffmpegPath && ffmpegPath.includes('app.asar')) {
        ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    }

    return ffmpegPath;
}

/**
 * Get corrected FFprobe path for Electron environment
 * @returns {string}
 */
function getFFprobePath() {
    let ffprobePath;
    try {
        const ffprobe = require('ffprobe-static');
        ffprobePath = ffprobe.path;
    } catch {
        ffprobePath = 'ffprobe';
    }

    if (ffprobePath && ffprobePath.includes('app.asar')) {
        ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');
    }

    return ffprobePath;
}

const captureDateCache = new Map();

function clearCaptureDateCache() {
    captureDateCache.clear();
}

function getCaptureDateCached(filePath) {
    if (captureDateCache.has(filePath)) {
        return captureDateCache.get(filePath);
    }
    return null;
}

function setCaptureDateCached(filePath, date) {
    captureDateCache.set(filePath, date);
}

function validateQuality(value) {
    const q = parseInt(value, 10);
    if (isNaN(q)) return 88;
    return Math.max(1, Math.min(100, q));
}

function validateCrf(value) {
    const crf = parseInt(value, 10);
    if (isNaN(crf)) return 22;
    return Math.max(0, Math.min(51, crf));
}

function validateImageFormat(format) {
    const valid = ['jpeg', 'jpg', 'webp', 'avif'];
    const f = format?.toLowerCase();
    const normalized = f === 'jpg' ? 'jpeg' : f;
    return valid.includes(normalized) ? normalized : 'webp';
}

function validateEncoder(encoder) {
    const valid = ['auto', 'nvenc', 'amf', 'qsv', 'x264', 'x265'];
    const e = encoder?.toLowerCase();
    return valid.includes(e) ? e : 'auto';
}

module.exports = {
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    isImage,
    isVideo,
    formatFileSize,
    getFileSize,
    getCompressionRatio,
    ensureDirectoryExists,
    generateOutputPath,
    normalizeOutputExtension,
    getOptimalConcurrency,
    getOptimalThreads,
    parallelProcess,
    getFilesRecursive,
    getCaptureDate,
    formatDateForFilename,
    formatDateForFolder,
    setFileMetadata,
    getFFmpegPath,
    getFFprobePath,
    clearCaptureDateCache,
    getCaptureDateCached,
    setCaptureDateCached,
    validateQuality,
    validateCrf,
    validateImageFormat,
    validateEncoder,
    getAvailableMemory,
    getRecommendedVideoConcurrency,
    isLowMemory,
    isAlreadyProcessed
};
