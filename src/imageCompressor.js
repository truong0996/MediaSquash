const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { ensureDirectoryExists, getFileSize, formatFileSize, getCompressionRatio, setFileMetadata } = require('./utils');

// Compression settings for different formats
// ADDED: heic support
const COMPRESSION_SETTINGS = {
    jpeg: { mozjpeg: true, quality: 75 },
    jpg: { mozjpeg: true, quality: 75 },
    png: { compressionLevel: 9, effort: 10 },
    webp: { quality: 75 },
    avif: { quality: 75 },
    tiff: { compression: 'lzw', quality: 75 },
    gif: { effort: 10 },
    heic: { quality: 75, compression: 'hevc' },
    heif: { quality: 75, compression: 'hevc' }
};

/**
 * Compress an image file
 * @param {string} inputPath - Path to input image
 * @param {string} outputPath - Path to output image
 * @param {Object} options - Compression options
 * @returns {Promise<Object>} - Compression result with stats
 */
async function compressImage(inputPath, outputPath, options = {}) {
    const ext = path.extname(inputPath).toLowerCase().slice(1);
    const originalSize = getFileSize(inputPath);

    // Ensure output directory exists
    ensureDirectoryExists(outputPath);

    // Get format-specific settings
    const formatSettings = COMPRESSION_SETTINGS[ext] || COMPRESSION_SETTINGS.jpeg;
    const settings = { ...formatSettings, ...options };

    // Create sharp instance
    // .rotate() without arguments auto-rotates based on EXIF orientation
    // .withMetadata() preserves EXIF data including GPS location, date, etc.
    let pipeline = sharp(inputPath).rotate().withMetadata();

    // Apply format-specific compression
    switch (ext) {
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
        // ADDED: HEIC/HEIF support
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

    // NEW LOGIC: Use original file if compressed is larger
    if (compressedSize > originalSize) {
        fs.copyFileSync(inputPath, outputPath);
        // Force metadata update immediately
        setFileMetadata(inputPath, outputPath);
        compressedSize = originalSize;
        note = ' (used original, compressed was larger)';
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