const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { ensureDirectoryExists, getFileSize, formatFileSize, getCompressionRatio, setFileMetadata } = require('./utils');

// Compression settings for different formats
const COMPRESSION_SETTINGS = {
    jpeg: { mozjpeg: true, quality: 75 },
    jpg: { mozjpeg: true, quality: 75 },
    png: { compressionLevel: 9, effort: 10 },
    webp: { quality: 75 },
    avif: { quality: 75 },
    tiff: { compression: 'lzw', quality: 75 },
    gif: { effort: 10 },
    heic: { quality: 75 },
    heif: { quality: 75 }
};

/**
 * Convert HEIC/HEIF to compressed PNG using heic-convert + Sharp
 * @param {string} inputPath - Path to HEIC file
 * @param {string} outputPath - Path to output PNG
 * @param {Object} options - Compression options (quality, etc.)
 * @returns {Promise<void>}
 */
async function convertHeicToPng(inputPath, outputPath, options = {}) {
    // Dynamic import for ESM module
    const convert = (await import('heic-convert')).default;

    const inputBuffer = fs.readFileSync(inputPath);

    // Convert HEIC to raw PNG buffer
    const rawPngBuffer = await convert({
        buffer: inputBuffer,
        format: 'PNG',
        quality: 1 // Max quality for initial conversion
    });

    // Compress the PNG with Sharp for smaller file size
    await sharp(rawPngBuffer)
        .rotate() // Auto-rotate based on EXIF
        .withMetadata()
        .png({
            compressionLevel: 9,
            effort: 10
        })
        .toFile(outputPath);
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
    const originalSize = getFileSize(inputPath);

    // Ensure output directory exists
    ensureDirectoryExists(outputPath);

    // Use output extension for format selection (enables HEIC→PNG conversion)
    const targetFormat = outputExt || inputExt;
    const formatSettings = COMPRESSION_SETTINGS[targetFormat] || COMPRESSION_SETTINGS.jpeg;
    const settings = { ...formatSettings, ...options };

    // Special handling for HEIC/HEIF input (Sharp lacks HEIF plugin on most systems)
    // Use heic-convert package for native HEIC decoding
    if (inputExt === 'heic' || inputExt === 'heif') {
        await convertHeicToPng(inputPath, outputPath);

        const compressedSize = getFileSize(outputPath);
        return {
            input: inputPath,
            output: outputPath,
            originalSize,
            compressedSize,
            originalSizeFormatted: formatFileSize(originalSize),
            compressedSizeFormatted: formatFileSize(compressedSize),
            savings: getCompressionRatio(originalSize, compressedSize) + ' (converted from HEIC)',
            success: true
        };
    }

    // Create sharp instance for non-HEIC files
    // .rotate() without arguments auto-rotates based on EXIF orientation
    // .withMetadata() preserves EXIF data including GPS location, date, etc.
    let pipeline = sharp(inputPath).rotate().withMetadata();

    // Apply format-specific compression based on OUTPUT format
    switch (targetFormat) {
        case 'jpg':
        case 'jpeg':
            pipeline = pipeline.jpeg({
                mozjpeg: settings.mozjpeg !== false,
                quality: settings.quality || 75
            });
            break;
        case 'png':
            pipeline = pipeline.png({
                compressionLevel: settings.compressionLevel || 9,
                effort: settings.effort || 10
            });
            break;
        case 'webp':
            pipeline = pipeline.webp({
                quality: settings.quality || 75
            });
            break;
        case 'avif':
            pipeline = pipeline.avif({
                quality: settings.quality || 75
            });
            break;
        case 'tiff':
            pipeline = pipeline.tiff({
                compression: settings.compression || 'lzw',
                quality: settings.quality || 75
            });
            break;
        case 'gif':
            pipeline = pipeline.gif({
                effort: settings.effort || 10
            });
            break;
        case 'heic':
        case 'heif':
            pipeline = pipeline.heif({
                quality: settings.quality || 75,
                compression: settings.compression || 'hevc'
            });
            break;
        default:
            // For unsupported formats, try to convert to jpeg
            pipeline = pipeline.jpeg({
                mozjpeg: true,
                quality: settings.quality || 75
            });
    }

    // Write output
    await pipeline.toFile(outputPath);

    let compressedSize = getFileSize(outputPath);
    let note = '';

    // Check if we're converting formats (e.g., HEIC to PNG)
    const isConvertingFormat = inputExt !== targetFormat;

    // Use original file if compressed is larger, but ONLY if not converting formats
    // When converting formats, we must keep the converted version for compatibility
    if (compressedSize > originalSize && !isConvertingFormat) {
        fs.copyFileSync(inputPath, outputPath);
        // Force metadata update immediately
        setFileMetadata(inputPath, outputPath);
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
    getSupportedExtensions,
    COMPRESSION_SETTINGS
};