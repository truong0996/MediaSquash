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
 * Convert HEIC/HEIF to compressed JPEG using heic-convert + Sharp
 * Falls back to Sharp if the file is not a valid HEIC (may be mislabeled)
 * @param {string} inputPath - Path to HEIC file
 * @param {string} outputPath - Path to output JPEG
 * @param {Object} options - Compression options (quality, etc.)
 * @returns {Promise<{success: boolean, usedFallback: boolean}>}
 */
async function convertHeicToJpeg(inputPath, outputPath, options = {}) {
    const inputBuffer = fs.readFileSync(inputPath);
    const quality = options.quality || 75;

    // Check magic bytes to verify file format
    // HEIC/HEIF files start with "ftyp" at byte 4-8
    const hasFtypHeader = inputBuffer.length > 12 &&
        inputBuffer.toString('ascii', 4, 8) === 'ftyp';

    // Common HEIC/HEIF brand codes
    const brand = inputBuffer.length > 12 ? inputBuffer.toString('ascii', 8, 12) : '';
    const heicBrands = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'miaf'];
    const isLikelyHeic = hasFtypHeader && heicBrands.some(b => brand.toLowerCase().startsWith(b.toLowerCase()));

    // Try heic-convert first if it looks like HEIC
    if (isLikelyHeic) {
        try {
            const convert = (await import('heic-convert')).default;

            // Convert HEIC to raw JPEG buffer
            const rawJpegBuffer = await convert({
                buffer: inputBuffer,
                format: 'JPEG',
                quality: 1 // Max quality for initial conversion, Sharp will handle final compression
            });

            // Compress the JPEG with Sharp for optimal file size
            await sharp(rawJpegBuffer)
                .rotate() // Auto-rotate based on EXIF
                .withMetadata()
                .jpeg({
                    mozjpeg: true,
                    quality: quality
                })
                .toFile(outputPath);

            return { success: true, usedFallback: false };
        } catch (heicError) {
            // heic-convert failed, try Sharp fallback
            console.log(`    ⚠️  HEIC decode failed, trying Sharp fallback...`);
        }
    }

    // Fallback: Try Sharp directly (works if file is mislabeled or Sharp has HEIF support)
    try {
        await sharp(inputPath)
            .rotate()
            .withMetadata()
            .jpeg({
                mozjpeg: true,
                quality: quality
            })
            .toFile(outputPath);

        return { success: true, usedFallback: true };
    } catch (sharpError) {
        // Both methods failed - throw a combined error
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
    const originalSize = getFileSize(inputPath);

    // Ensure output directory exists
    ensureDirectoryExists(outputPath);

    // Use output extension for format selection (enables HEIC→PNG conversion)
    const targetFormat = outputExt || inputExt;
    const formatSettings = COMPRESSION_SETTINGS[targetFormat] || COMPRESSION_SETTINGS.jpeg;
    const settings = { ...formatSettings, ...options };

    // Special handling for HEIC/HEIF input (Sharp lacks HEIF plugin on most systems)
    // Use heic-convert package for native HEIC decoding, with Sharp fallback
    if (inputExt === 'heic' || inputExt === 'heif') {
        const result = await convertHeicToJpeg(inputPath, outputPath, { quality: settings.quality });

        const compressedSize = getFileSize(outputPath);
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

    // Create sharp instance for non-HEIC files
    // .rotate() without arguments auto-rotates based on EXIF orientation
    // .withMetadata() preserves EXIF data including GPS location, date, etc.

    try {
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
    } catch (sharpError) {
        // Handle corrupted or malformed images (e.g., "Invalid SOS parameters for sequential JPEG")
        // Copy original file as fallback
        console.log(`    ⚠️  Image processing failed (${sharpError.message}), copying original...`);
        fs.copyFileSync(inputPath, outputPath);
        setFileMetadata(inputPath, outputPath);

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
    getSupportedExtensions,
    COMPRESSION_SETTINGS
};