const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');
const exifReader = require('exif-reader');
const ffmpeg = require('fluent-ffmpeg');
const ffprobe = require('ffprobe-static');

// Supported file extensions
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tiff', '.gif', '.heic', '.heif'];
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.3gp', '.m4v', '.mpeg', '.mpg'];
const IMAGE_EXT_SET = new Set(IMAGE_EXTENSIONS);
const VIDEO_EXT_SET = new Set(VIDEO_EXTENSIONS);

/**
 * Get writable application data directory (safe inside packaged .asar builds).
 * @returns {string}
 */
function getWritableDataDir() {
    if (__dirname.includes('.asar')) {
        const root = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
        return path.join(root, 'MediaSquash');
    }
    return path.join(__dirname, '..');
}

/**
 * Normalize output file extension for consistent format
 * Images -> .webp (default), .jpeg, or .avif | Videos -> .mp4
 * @param {string} filePath - File path to normalize
 * @param {string} [imageFormat='webp'] - Target image format
 * @param {string|null} [actualType=null] - Optional content-sniffed type ('image' | 'video')
 * @returns {string} - Normalized file path with consistent extension
 */
function normalizeOutputExtension(filePath, imageFormat = 'webp', actualType = null) {
    const ext = path.extname(filePath).toLowerCase();
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));

    if (actualType === 'image' || (!actualType && IMAGE_EXT_SET.has(ext))) {
        const targetExt = imageFormat.startsWith('.') ? imageFormat : `.${imageFormat}`;
        return path.join(dir, `${baseName}${targetExt}`);
    }

    if (actualType === 'video' || (!actualType && VIDEO_EXT_SET.has(ext))) {
        return path.join(dir, `${baseName}.mp4`);
    }

    return filePath;
}

/**
 * Sniff file magic bytes to determine actual media type (catches iPhone Live Photo
 * JPEGs saved as .MOV/.MP4, Apple .plist/.AAE files saved as .MOV, and 0-byte files).
 * @param {string} filePath
 * @param {number} [knownSize]
 * @returns {Promise<{ kind: 'image'|'video'|'invalid', format?: string, reason?: string, size: number }>}
 */
async function inspectMediaFile(filePath, knownSize) {
    let size = knownSize;
    if (typeof size !== 'number') {
        try {
            const st = await fs.promises.stat(filePath);
            if (!st.isFile()) return { kind: 'invalid', reason: 'not-a-file', size: 0 };
            size = st.size;
        } catch {
            return { kind: 'invalid', reason: 'missing', size: 0 };
        }
    }

    if (size === 0) return { kind: 'invalid', reason: 'empty', size: 0 };
    if (size < 12) return { kind: 'invalid', reason: 'truncated', size };

    const buf = Buffer.alloc(32);
    let bytesRead = 0;
    try {
        const handle = await fs.promises.open(filePath, 'r');
        try {
            const res = await handle.read(buf, 0, 32, 0);
            bytesRead = res.bytesRead;
        } finally {
            await handle.close();
        }
    } catch {
        return { kind: 'invalid', reason: 'unreadable', size };
    }

    if (bytesRead < 12) return { kind: 'invalid', reason: 'truncated', size };

    // JPEG (including Apple AMPF/MPF Live Photo stills saved with .MOV/.MP4 extension)
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { kind: 'image', format: 'jpeg', size };
    }
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { kind: 'image', format: 'png', size };
    }
    // RIFF: WebP vs AVI
    if (buf.toString('ascii', 0, 4) === 'RIFF') {
        const riffType = buf.toString('ascii', 8, 12);
        if (riffType === 'WEBP') return { kind: 'image', format: 'webp', size };
        if (riffType === 'AVI ') return { kind: 'video', format: 'avi', size };
    }
    // GIF
    const head6 = buf.toString('ascii', 0, 6);
    if (head6 === 'GIF87a' || head6 === 'GIF89a') {
        return { kind: 'image', format: 'gif', size };
    }
    // TIFF
    if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
        (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) {
        return { kind: 'image', format: 'tiff', size };
    }
    // XML / Apple .plist / .AAE adjustment sidecar mislabeled as .MOV/.MP4
    const headAscii = buf.toString('ascii', 0, Math.min(bytesRead, 16)).trimStart();
    if (headAscii.startsWith('<?xml') || headAscii.startsWith('<plist') || buf.toString('ascii', 0, 6) === 'bplist') {
        return { kind: 'invalid', reason: 'metadata-plist', size };
    }
    // ISO BMFF (ftyp): distinguish HEIC/AVIF images from QuickTime/MP4 videos
    if (buf.toString('ascii', 4, 8) === 'ftyp') {
        const brand = buf.toString('ascii', 8, 12).toLowerCase();
        if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'miaf'].some(b => brand.startsWith(b))) {
            return { kind: 'image', format: 'heic', size };
        }
        if (brand.startsWith('avif') || brand.startsWith('avis')) {
            return { kind: 'image', format: 'avif', size };
        }
        return { kind: 'video', format: brand.trim(), size };
    }
    // EBML (MKV / WebM)
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
        return { kind: 'video', format: 'matroska', size };
    }
    // FLV
    if (buf.toString('ascii', 0, 3) === 'FLV') {
        return { kind: 'video', format: 'flv', size };
    }

    if (IMAGE_EXT_SET.has(path.extname(filePath).toLowerCase())) {
        return { kind: 'image', size };
    }
    if (VIDEO_EXT_SET.has(path.extname(filePath).toLowerCase())) {
        return { kind: 'video', size };
    }
    return { kind: 'invalid', reason: 'unsupported', size };
}

/**
 * Get optimal concurrency based on CPU cores
 * @returns {number}
 */
function getOptimalConcurrency() {
    const cpuCount = os.cpus().length || 4;
    return Math.max(1, Math.min(Math.floor(cpuCount / 2), 8));
}

/**
 * Get number of threads for FFmpeg based on CPU cores
 * @returns {number}
 */
function getOptimalThreads() {
    const cpuCount = os.cpus().length || 4;
    return Math.max(1, cpuCount - 1);
}

/**
 * Get available system memory in bytes
 * @returns {number}
 */
function getAvailableMemory() {
    try {
        return os.freemem();
    } catch {
        return 0;
    }
}

/**
 * Get recommended video concurrency based on encoder type, CPU cores, and free RAM.
 * Hardware encoders saturate around 2-3 concurrent sessions (consumer NVENC session limits),
 * while software encoders (x264/x265) scale better with fewer workers and more threads each.
 * @param {number} videoCount - Number of videos to process
 * @param {string} [encoderType='auto'] - Resolved or requested encoder type
 * @returns {number}
 */
function getRecommendedVideoConcurrency(videoCount, encoderType = 'auto') {
    if (!videoCount || videoCount <= 0) return 1;

    const cpuCount = os.cpus().length || 4;
    const freeMem = getAvailableMemory();
    const maxByMem = freeMem > 0 ? Math.max(1, Math.floor(freeMem / (2 * 1024 * 1024 * 1024))) : 2;
    const isSoftware = encoderType === 'x264' || encoderType === 'x265';

    let maxByEncoder;
    if (isSoftware) {
        // Give each x264/x265 process at least ~4 cores so it doesn't thrash
        maxByEncoder = Math.max(1, Math.min(Math.floor(cpuCount / 4), 3));
    } else {
        // Hardware encoders (NVENC/AMF/QSV): 2 concurrent keeps the ASIC busy without hitting session caps
        maxByEncoder = (cpuCount >= 12 && freeMem >= 8 * 1024 * 1024 * 1024) ? 3 : 2;
    }

    const recommended = Math.min(maxByEncoder, maxByMem, videoCount);
    return Math.max(1, recommended);
}

/**
 * Compute per-video FFmpeg thread budget to prevent oversubscription across workers.
 * @param {number} videoConcurrency - Number of concurrent video jobs
 * @param {Object} [options]
 * @param {string} [options.encoderType='auto'] - Encoder type
 * @param {boolean} [options.overlapWithImages=false] - Whether image pool runs concurrently
 * @returns {number}
 */
function getOptimalVideoThreads(videoConcurrency, options = {}) {
    const cpuCount = os.cpus().length || 4;
    const workers = Math.max(1, videoConcurrency || 1);
    const { encoderType = 'auto', overlapWithImages = false } = options;
    const isSoftware = encoderType === 'x264' || encoderType === 'x265';

    if (isSoftware) {
        const available = Math.max(1, cpuCount - 1);
        return Math.max(1, Math.min(8, Math.floor(available / workers)));
    }

    // Hardware encoders still use CPU for audio, demux, decode fallback, and pixel-format conversion
    const available = overlapWithImages
        ? Math.max(2, Math.floor(cpuCount / 2))
        : Math.max(2, cpuCount - 1);
    return Math.max(1, Math.min(4, Math.floor(available / workers)));
}

/**
 * Check if system is low on memory (below 1GB free)
 * @returns {boolean}
 */
function isLowMemory() {
    const freeMem = getAvailableMemory();
    return freeMem < 1024 * 1024 * 1024;
}

/**
 * Check if a file has already been processed
 * @param {string} inputPath - Input file path
 * @param {string} outputPath - Output file path
 * @param {fs.Stats} [knownOutputStat] - Pre-fetched stat for outputPath
 * @param {fs.Stats} [knownInputStat] - Pre-fetched stat for inputPath
 * @returns {boolean}
 */
function isAlreadyProcessed(inputPath, outputPath, knownOutputStat, knownInputStat) {
    try {
        if (!knownOutputStat && !fs.existsSync(outputPath)) return false;

        const inputStat = knownInputStat || fs.statSync(inputPath);
        const outputStat = knownOutputStat || fs.statSync(outputPath);

        if (outputStat.mtimeMs > inputStat.mtimeMs) {
            return true;
        }

        const outputCreatedMs = Math.max(outputStat.birthtimeMs || 0, outputStat.ctimeMs || 0);
        const inputUpdatedMs = Math.max(inputStat.birthtimeMs || 0, inputStat.ctimeMs || 0, inputStat.mtimeMs || 0);
        if (outputCreatedMs > inputUpdatedMs) return true;
    } catch {}
    return false;
}

/**
 * Process items in parallel with a fixed-size worker pool.
 * Avoids unbounded promise-array retention when collectResults is false.
 * @param {Array} items - Items to process
 * @param {Function} processor - Async function to process each item
 * @param {number} concurrency - Maximum concurrent operations
 * @param {Object} [options]
 * @param {boolean} [options.collectResults=true] - Whether to collect and return per-item results
 * @param {Function} [options.shouldCancel] - Optional predicate checked before pulling next item
 * @returns {Promise<Array>}
 */
async function parallelProcess(items, processor, concurrency, options = {}) {
    const { collectResults = true, shouldCancel = null } = options;
    if (!Array.isArray(items) || items.length === 0) return [];

    const workerCount = Math.max(1, Math.min(concurrency || 1, items.length));
    const results = collectResults ? new Array(items.length) : [];
    let nextIndex = 0;

    async function worker() {
        while (true) {
            if (shouldCancel && shouldCancel()) break;
            const currentIndex = nextIndex++;
            if (currentIndex >= items.length) break;

            const item = items[currentIndex];
            try {
                const res = await processor(item, currentIndex);
                if (collectResults) results[currentIndex] = res;
            } catch (error) {
                if (collectResults) results[currentIndex] = { error, item };
            }
        }
    }

    const workers = [];
    for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

/**
 * Check if a file is an image based on extension
 * @param {string} filePath - Path to the file
 * @returns {boolean}
 */
function isImage(filePath) {
    return IMAGE_EXT_SET.has(path.extname(filePath).toLowerCase());
}

/**
 * Check if a file is a video based on extension
 * @param {string} filePath - Path to the file
 * @returns {boolean}
 */
function isVideo(filePath) {
    return VIDEO_EXT_SET.has(path.extname(filePath).toLowerCase());
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
        return fs.statSync(filePath).size;
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
        const ext = path.extname(inputPath);
        const base = path.basename(inputPath, ext);
        const dir = path.dirname(inputPath);
        return path.join(dir, `${base}${suffix || '_compressed'}${ext}`);
    }

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
        const filename = path.basename(inputPath);
        return path.join(outputPath, filename);
    }

    return outputPath;
}

/**
 * Get all files in a directory recursively using dirent types (avoids per-file statSync).
 * @param {string} dir - Directory to search
 * @param {Function} filter - Filter function for files
 * @returns {string[]}
 */
function getFilesRecursive(dir, filter) {
    const results = [];
    const stack = [dir];

    while (stack.length > 0) {
        const currentDir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.isFile()) {
                if (!filter || filter(fullPath)) {
                    results.push(fullPath);
                }
            } else if (entry.isSymbolicLink()) {
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        stack.push(fullPath);
                    } else if (stat.isFile() && (!filter || filter(fullPath))) {
                        results.push(fullPath);
                    }
                } catch {}
            }
        }
    }

    return results;
}

/**
 * Asynchronously scan a directory (optionally recursively) and collect file stats
 * in bounded parallel batches without blocking the Node.js event loop.
 * @param {string} dir - Directory to scan
 * @param {Function|null} filter - File path predicate
 * @param {boolean} recursive - Scan subdirectories
 * @returns {Promise<Array<{ path: string, size: number }>>}
 */
async function scanFilesAsync(dir, filter, recursive = false) {
    const candidatePaths = [];
    const stack = [dir];

    while (stack.length > 0) {
        const currentDir = stack.pop();
        let entries;
        try {
            entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                if (recursive) stack.push(fullPath);
            } else if (entry.isFile()) {
                if (!filter || filter(fullPath)) {
                    candidatePaths.push(fullPath);
                }
            } else if (entry.isSymbolicLink()) {
                try {
                    const stat = await fs.promises.stat(fullPath);
                    if (stat.isDirectory()) {
                        if (recursive) stack.push(fullPath);
                    } else if (stat.isFile() && (!filter || filter(fullPath))) {
                        candidatePaths.push(fullPath);
                    }
                } catch {}
            }
        }
    }

    const scanned = new Array(candidatePaths.length);
    let writeIdx = 0;

    await parallelProcess(
        candidatePaths,
        async (filePath) => {
            try {
                const stats = await fs.promises.stat(filePath);
                if (!stats.isFile()) return;
                const info = await inspectMediaFile(filePath, stats.size);
                if (info.kind === 'invalid') return;
                scanned[writeIdx++] = {
                    path: filePath,
                    size: stats.size,
                    type: info.kind,
                    actualFormat: info.format || null
                };
            } catch {}
        },
        32,
        { collectResults: false }
    );

    scanned.length = writeIdx;
    return scanned;
}

// Set ffprobe path once (with Electron fix)
let ffprobePath = ffprobe.path;
if (ffprobePath && ffprobePath.includes('app.asar')) {
    ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');
}
ffmpeg.setFfprobePath(ffprobePath);

// Directory listings are cached because findJsonSidecar runs once per media file.
// Prefix-8 bucketing turns fuzzy matching on large Google Takeout exports from O(N^2) to O(1).
const dirEntryCache = new Map();
const DIR_CACHE_MAX = 64;

function getDirEntries(dir) {
    const cached = dirEntryCache.get(dir);
    if (cached) return cached;

    let entries;
    try {
        const files = fs.readdirSync(dir);
        const byLowerName = new Map();
        const jsonFiles = [];
        const jsonByPrefix8 = new Map();

        for (const f of files) {
            const lower = f.toLowerCase();
            byLowerName.set(lower, f);
            if (lower.endsWith('.json')) {
                jsonFiles.push(f);
                const prefix8 = lower.slice(0, 8);
                let bucket = jsonByPrefix8.get(prefix8);
                if (!bucket) {
                    bucket = [];
                    jsonByPrefix8.set(prefix8, bucket);
                }
                bucket.push(f);
            }
        }
        entries = { byLowerName, jsonFiles, jsonByPrefix8 };
    } catch {
        entries = { byLowerName: new Map(), jsonFiles: [], jsonByPrefix8: new Map() };
    }

    if (dirEntryCache.size >= DIR_CACHE_MAX) dirEntryCache.clear();
    dirEntryCache.set(dir, entries);
    return entries;
}

function clearDirEntryCache() {
    dirEntryCache.clear();
}

// Helper to find Google Takeout JSON sidecar with O(1) fuzzy matching
function findJsonSidecar(filePath) {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const extension = path.extname(filePath);
    const baseName = path.basename(filePath, extension);

    const { byLowerName, jsonByPrefix8 } = getDirEntries(dir);
    if (byLowerName.size === 0) return null;

    const exactCandidates = [
        fileName + '.json',
        fileName + '.supplemental-metadata.json'
    ];
    for (const exact of exactCandidates) {
        const actual = byLowerName.get(exact.toLowerCase());
        if (actual) return path.join(dir, actual);
    }

    if (baseName.length < 8) return null;

    const prefix8 = fileName.slice(0, 8).toLowerCase();
    const candidates = jsonByPrefix8.get(prefix8);
    if (!candidates || candidates.length === 0) return null;

    let bestMatch = null;
    let bestMatchLen = 0;

    for (const jsonFile of candidates) {
        const jsonBase = path.basename(jsonFile, '.json');

        if (jsonFile.startsWith(fileName)) {
            if (jsonFile.length > bestMatchLen) {
                bestMatch = path.join(dir, jsonFile);
                bestMatchLen = jsonFile.length;
            }
            continue;
        }

        if (baseName.startsWith(jsonBase) && jsonBase.length >= 8) {
            if (jsonFile.length > bestMatchLen) {
                bestMatch = path.join(dir, jsonFile);
                bestMatchLen = jsonFile.length;
            }
        }
    }

    return bestMatch;
}

// ffprobe spawns a child process per call. A video is probed for capture date,
// adaptive CRF, and audio stream inspection; results and in-flight promises are shared.
const probeCache = new Map();

/**
 * Run ffprobe on a video, reusing any cached or in-flight result.
 * @param {string} filePath
 * @returns {Promise<Object|null>} - ffprobe metadata, or null if probing failed
 */
function probeVideo(filePath) {
    const cached = probeCache.get(filePath);
    if (cached) return cached;

    const promise = new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            resolve(err ? null : metadata);
        });
    });

    probeCache.set(filePath, promise);
    return promise;
}

function evictProbeCache(filePath) {
    probeCache.delete(filePath);
}

function clearProbeCache() {
    probeCache.clear();
}

const createdDirCache = new Set();

/**
 * Ensure a directory exists, skipping the syscall if already created this run.
 * @param {string} dir - Directory path
 */
function ensureDirCached(dir) {
    if (createdDirCache.has(dir)) return;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    createdDirCache.add(dir);
}

function clearCreatedDirCache() {
    createdDirCache.clear();
}

const captureDateCache = new Map();
const captureDateInFlight = new Map();

/**
 * Get capture date from metadata (deduplicated for concurrent lookups).
 * @param {string} filePath
 * @returns {Promise<Date|null>}
 */
async function getCaptureDate(filePath) {
    if (captureDateCache.has(filePath)) {
        return captureDateCache.get(filePath);
    }
    const pending = captureDateInFlight.get(filePath);
    if (pending) return pending;

    const task = resolveCaptureDate(filePath).finally(() => {
        captureDateInFlight.delete(filePath);
    });
    captureDateInFlight.set(filePath, task);
    return task;
}

async function resolveCaptureDate(filePath) {
    const toLocalAsUTC = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    let result = null;

    const jsonPath = findJsonSidecar(filePath);
    if (jsonPath) {
        try {
            const rawJson = await fs.promises.readFile(jsonPath, 'utf8');
            const jsonContent = JSON.parse(rawJson);
            if (jsonContent.photoTakenTime && jsonContent.photoTakenTime.timestamp) {
                const timestamp = parseInt(jsonContent.photoTakenTime.timestamp, 10) * 1000;
                if (!isNaN(timestamp)) {
                    result = toLocalAsUTC(new Date(timestamp));
                }
            }
        } catch {
        }
    }

    const inspected = await inspectMediaFile(filePath);
    const actualIsImage = inspected.kind === 'image' || (inspected.kind !== 'video' && isImage(filePath));
    const actualIsVideo = inspected.kind === 'video' || (inspected.kind !== 'image' && isVideo(filePath));

    if (!result && actualIsImage) {
        try {
            const metadata = await sharp(filePath).metadata();
            if (metadata.exif) {
                const exif = exifReader(metadata.exif);
                const exifDate = exif.Photo?.DateTimeOriginal || exif.Image?.DateTime;
                if (exifDate) {
                    result = new Date(exifDate);
                }
            }
        } catch {
        }

        if (!result) {
            try {
                const stats = await fs.promises.stat(filePath);
                result = toLocalAsUTC(stats.mtime);
            } catch {
            }
        }
    }

    if (!result && actualIsVideo) {
        try {
            const metadata = await probeVideo(filePath);
            if (metadata) {
                const tags = metadata.format?.tags || {};
                const creationTime =
                    tags['com.apple.quicktime.creationdate'] ||
                    tags['creation_date'] ||
                    tags['creation_time'] ||
                    metadata.streams?.find(s => s.tags?.creation_time)?.tags?.creation_time;

                if (creationTime) {
                    const dateObj = new Date(creationTime);
                    if (!isNaN(dateObj.getTime())) {
                        result = toLocalAsUTC(dateObj);
                    }
                }
            }
        } catch {
        }

        if (!result) {
            const dir = path.dirname(filePath);
            const ext = path.extname(filePath);
            const baseName = path.basename(filePath, ext);
            const { byLowerName } = getDirEntries(dir);
            const selfLower = path.resolve(filePath).toLowerCase();

            const imageCandidates = ['.heic', '.heif', '.jpg', '.jpeg', '.png'];
            for (const imgExt of imageCandidates) {
                const actualName = byLowerName.get((baseName + imgExt).toLowerCase());
                if (actualName) {
                    const siblingPath = path.join(dir, actualName);
                    if (path.resolve(siblingPath).toLowerCase() === selfLower) continue;
                    if (captureDateInFlight.has(siblingPath)) continue;
                    const siblingInfo = await inspectMediaFile(siblingPath);
                    if (siblingInfo.kind !== 'image') continue;
                    const siblingDate = await getCaptureDate(siblingPath);
                    if (siblingDate) {
                        result = siblingDate;
                        break;
                    }
                }
            }
        }

        if (!result) {
            try {
                const stats = await fs.promises.stat(filePath);
                result = toLocalAsUTC(stats.mtime);
            } catch {
            }
        }
    }

    setCaptureDateCached(filePath, result);
    return result;
}

function formatDateForFilename(date) {
    if (!date || isNaN(date.getTime())) return 'unknown';

    const pad = (num) => String(num).padStart(2, '0');
    const year = date.getUTCFullYear();
    const month = pad(date.getUTCMonth() + 1);
    const day = pad(date.getUTCDate());
    const hours = pad(date.getUTCHours());
    const minutes = pad(date.getUTCMinutes());
    const seconds = pad(date.getUTCSeconds());

    return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function formatDateForFolder(date) {
    if (!date || isNaN(date.getTime())) return 'Unknown_Date';
    const pad = (num) => String(num).padStart(2, '0');
    const year = date.getUTCFullYear();
    const month = pad(date.getUTCMonth() + 1);
    return `${year}-${month}`;
}

/**
 * Preserve file metadata (atime and mtime)
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
 * Asynchronously preserve file timestamps (reuses pre-fetched source stat when provided).
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {fs.Stats} [knownSourceStat]
 */
async function setFileMetadataAsync(sourcePath, targetPath, knownSourceStat) {
    try {
        const stats = knownSourceStat || await fs.promises.stat(sourcePath);
        await fs.promises.utimes(targetPath, stats.atime, stats.mtime);
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
    let resolvedFfprobePath;
    try {
        resolvedFfprobePath = ffprobe.path;
    } catch {
        resolvedFfprobePath = 'ffprobe';
    }

    if (resolvedFfprobePath && resolvedFfprobePath.includes('app.asar')) {
        resolvedFfprobePath = resolvedFfprobePath.replace('app.asar', 'app.asar.unpacked');
    }

    return resolvedFfprobePath;
}

function clearCaptureDateCache() {
    captureDateCache.clear();
    captureDateInFlight.clear();
    clearDirEntryCache();
    clearProbeCache();
    clearCreatedDirCache();
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
    getOptimalVideoThreads,
    parallelProcess,
    getFilesRecursive,
    scanFilesAsync,
    getCaptureDate,
    formatDateForFilename,
    formatDateForFolder,
    setFileMetadata,
    setFileMetadataAsync,
    getFFmpegPath,
    getFFprobePath,
    getWritableDataDir,
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
    isAlreadyProcessed,
    inspectMediaFile,
    probeVideo,
    evictProbeCache,
    clearProbeCache,
    ensureDirCached,
    clearCreatedDirCache,
    clearDirEntryCache,
    findJsonSidecar
};
