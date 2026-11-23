const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    ensureDirCached,
    formatFileSize,
    getCompressionRatio,
    setFileMetadataAsync
} = require('./utils');
const { decodeHeicInWorker } = require('./heicWorker');

// Disable libvips operation cache: batch media compression is one-shot per file,
// so caching decoded bitmaps only bloats native RSS memory.
sharp.cache(false);

const COMPRESSION_SETTINGS = {
    jpeg: { mozjpeg: true, quality: 88 },
    jpg: { mozjpeg: true, quality: 88 },
    png: { compressionLevel: 9, effort: 7 },
    webp: { quality: 88, smartSubsample: true },
    avif: { quality: 88 },
    tiff: { compression: 'lzw', quality: 88 },
    gif: { effort: 7 },
    heic: { quality: 88 },
    heif: { quality: 88 }
};

const FORMAT_ALIASES = {
    jpg: 'jpeg',
    tif: 'tiff'
};

function normalizeFormatName(ext) {
    const lower = (ext || '').toLowerCase();
    return FORMAT_ALIASES[lower] || lower;
}

/**
 * Budget libvips internal threads per Sharp pipeline so workerCount * threads <= maxCores.
 * @param {number} workerCount
 * @param {number} [maxCores]
 * @returns {number}
 */
function configureSharpConcurrency(workerCount, maxCores = os.cpus().length || 4) {
    const budget = Math.max(1, Math.floor(maxCores / Math.max(1, workerCount || 1)));
    sharp.concurrency(budget);
    return budget;
}

/**
 * Read only the first 16 bytes of a file to detect HEIC/HEIF ftyp magic header.
 * @param {string} filePath
 * @returns {Promise<{ hasFtypHeader: boolean, brand: string }>}
 */
async function readFtypHeader(filePath) {
    const header = Buffer.alloc(16);
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const { bytesRead } = await handle.read(header, 0, 16, 0);
        if (bytesRead <= 12) return { hasFtypHeader: false, brand: '' };
        const hasFtypHeader = header.toString('ascii', 4, 8) === 'ftyp';
        const brand = header.toString('ascii', 8, 12);
        return { hasFtypHeader, brand };
    } finally {
        await handle.close();
    }
}

function applySharpFormat(pipeline, targetFormat, settings) {
    const quality = settings.quality || 88;
    switch (targetFormat) {
        case 'jpg':
        case 'jpeg':
            return pipeline.jpeg({
                mozjpeg: settings.mozjpeg !== false,
                quality
            });
        case 'png':
            return pipeline.png({
                compressionLevel: settings.compressionLevel || 9,
                effort: settings.effort || 7
            });
        case 'webp':
            return pipeline.webp({
                quality,
                smartSubsample: settings.smartSubsample !== false
            });
        case 'avif':
            return pipeline.avif({ quality });
        case 'tiff':
            return pipeline.tiff({
                compression: settings.compression || 'lzw',
                quality
            });
        case 'gif':
            return pipeline.gif({
                effort: settings.effort || 7
            });
        case 'heic':
        case 'heif':
            return pipeline.heif({
                quality,
                compression: settings.compression || 'hevc'
            });
        default:
            return pipeline.jpeg({
                mozjpeg: true,
                quality
            });
    }
}

/**
 * Convert HEIC/HEIF to target format off the main thread (heic-decode -> raw RGBA -> Sharp).
 * Falls back to Sharp directly if the file is mislabeled (e.g. a JPEG saved as .heic).
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Object} options
 * @returns {Promise<{success: boolean, usedFallback: boolean}>}
 */
async function convertHeicToTarget(inputPath, outputPath, options = {}) {
    const quality = options.quality || 88;
    const targetFormat = options.targetFormat || 'webp';
    const settings = { ...COMPRESSION_SETTINGS[targetFormat], ...options, quality };

    const { hasFtypHeader, brand } = await readFtypHeader(inputPath);
    const heicBrands = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'miaf'];
    const isLikelyHeic = hasFtypHeader && heicBrands.some(b => brand.toLowerCase().startsWith(b));

    if (isLikelyHeic) {
        try {
            const decoded = await decodeHeicInWorker(inputPath);
            let pipeline = sharp(decoded.data, {
                raw: {
                    width: decoded.width,
                    height: decoded.height,
                    channels: 4
                }
            });
            pipeline = applySharpFormat(pipeline, targetFormat, settings);
            await pipeline.toFile(outputPath);
            return { success: true, usedFallback: false };
        } catch {
            console.log(`    ⚠️  HEIC decode failed, trying Sharp fallback...`);
        }
    }

    try {
        let pipeline = sharp(inputPath)
            .rotate()
            .withMetadata();
        pipeline = applySharpFormat(pipeline, targetFormat, settings);
        await pipeline.toFile(outputPath);
        return { success: true, usedFallback: true };
    } catch {
        const fileName = path.basename(inputPath);
        throw new Error(
            `Unable to process HEIC file "${fileName}". ` +
            `The file may be corrupted, use an unsupported codec, or is not actually a HEIC image. ` +
            `(Magic bytes: ftyp=${hasFtypHeader}, brand=${brand})`
        );
    }
}

/**
 * Compress an image file
 * @param {string} inputPath - Path to input image
 * @param {string} outputPath - Path to output image
 * @param {Object} options - Compression options
 * @returns {Promise<Object>} - Compression result with stats
 */
async function compressImage(inputPath, outputPath, options = {}) {
    const inputExt = path.extname(inputPath).toLowerCase().slice(1);
    const outputExt = path.extname(outputPath).toLowerCase().slice(1);
    const originalSize = typeof options.originalSize === 'number'
        ? options.originalSize
        : (await fs.promises.stat(inputPath).then(s => s.size).catch(() => 0));

    if (originalSize === 0) {
        throw new Error('Empty 0-byte image file');
    }

    if (!options.skipDirCheck) {
        ensureDirCached(path.dirname(outputPath));
    }

    const sourceFormat = (options.actualFormat || inputExt).toLowerCase();
    const targetFormat = outputExt || sourceFormat;
    const formatSettings = COMPRESSION_SETTINGS[targetFormat] || COMPRESSION_SETTINGS.jpeg;
    const settings = { ...formatSettings, ...options };

    if (sourceFormat === 'heic' || sourceFormat === 'heif') {
        const result = await convertHeicToTarget(inputPath, outputPath, {
            quality: settings.quality,
            targetFormat
        });

        const compressedSize = await fs.promises.stat(outputPath).then(s => s.size).catch(() => 0);
        const conversionNote = result.usedFallback
            ? ' (converted via Sharp fallback)'
            : ' (converted from HEIC)';
        return {
            input: inputPath,
            output: outputPath,
            originalSize,
            compressedSize,
            originalSizeFormatted: formatFileSize(originalSize),
            compressedSizeFormatted: formatFileSize(compressedSize),
            savings: getCompressionRatio(originalSize, compressedSize) + conversionNote,
            success: true
        };
    }

    const samePath = path.resolve(inputPath) === path.resolve(outputPath);
    const writePath = samePath
        ? `${outputPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${targetFormat || 'tmp'}`
        : outputPath;

    try {
        let pipeline = sharp(inputPath).rotate().withMetadata();
        pipeline = applySharpFormat(pipeline, targetFormat, settings);
        await pipeline.toFile(writePath);

        if (samePath) {
            await fs.promises.rename(writePath, outputPath);
        }

        let compressedSize = await fs.promises.stat(outputPath).then(s => s.size).catch(() => 0);
        let note = '';

        const isConvertingFormat = normalizeFormatName(sourceFormat) !== normalizeFormatName(targetFormat);

        if (compressedSize > originalSize && !isConvertingFormat) {
            if (!samePath) {
                await fs.promises.copyFile(inputPath, outputPath);
            }
            await setFileMetadataAsync(inputPath, outputPath);
            compressedSize = originalSize;
            note = ' (used original, compressed was larger)';
        } else if (compressedSize > originalSize && isConvertingFormat) {
            note = ' (kept converted file for compatibility)';
        }

        return {
            input: inputPath,
            output: outputPath,
            originalSize,
            compressedSize,
            originalSizeFormatted: formatFileSize(originalSize),
            compressedSizeFormatted: formatFileSize(compressedSize),
            savings: getCompressionRatio(originalSize, compressedSize) + note,
            success: true
        };
    } catch (sharpError) {
        if (samePath) {
            await fs.promises.unlink(writePath).catch(() => {});
        }
        console.log(`    ⚠️  Image processing failed (${sharpError.message}), copying original...`);
        if (!samePath) {
            await fs.promises.copyFile(inputPath, outputPath);
        }
        await setFileMetadataAsync(inputPath, outputPath);

        return {
            input: inputPath,
            output: outputPath,
            originalSize,
            compressedSize: originalSize,
            originalSizeFormatted: formatFileSize(originalSize),
            compressedSizeFormatted: formatFileSize(originalSize),
            savings: '0% (copied original - file may be corrupted)',
            success: true
        };
    }
}

/**
 * Get supported image extensions
 * @returns {string[]}
 */
function getSupportedExtensions() {
    return Object.keys(COMPRESSION_SETTINGS);
}

module.exports = {
    compressImage,
    configureSharpConcurrency,
    getSupportedExtensions,
    COMPRESSION_SETTINGS
};
