const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const { ensureDirectoryExists, getFileSize, formatFileSize, getCompressionRatio, getOptimalThreads, setFileMetadata } = require('./utils');
const { getEncoderConfig, detectAvailableEncoders } = require('./hwEncoder');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Default compression settings
const DEFAULT_SETTINGS = {
    encoder: 'auto', // 'auto', 'nvenc', 'qsv', or 'cpu'
    crf: 22,
    preset: 'veryfast', // For CPU encoder
    audioCodec: 'aac',
    audioBitrate: '128k',
    threads: 0, // 0 = auto (for CPU encoder)
    videoJobs: 2 // Number of videos to process in parallel
};

// Supported video extensions
const SUPPORTED_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.3gp', '.m4v', '.mpeg', '.mpg'];

/**
 * Compress a video file using FFmpeg with hardware acceleration support
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output video
 * @param {Object} options - Compression options
 * @returns {Promise<Object>} - Compression result with stats
 */
async function compressVideo(inputPath, outputPath, options = {}) {
    const settings = { ...DEFAULT_SETTINGS, ...options };
    const originalSize = getFileSize(inputPath);

    // Ensure output directory exists
    ensureDirectoryExists(outputPath);

    // Get output extension to determine container format
    const outputExt = path.extname(outputPath).toLowerCase();

    // Get encoder configuration (handles auto-detection and fallback)
    const encoderConfig = await getEncoderConfig(settings.encoder);

    // Calculate optimal threads for CPU encoder
    const threads = settings.threads || getOptimalThreads();

    return new Promise((resolve, reject) => {
        // Get encoder-specific output options
        let outputOptions;
        if (encoderConfig.type === 'x264' || encoderConfig.type === 'x265') {
            outputOptions = encoderConfig.getOutputOptions(settings.crf, settings.preset, threads);
        } else {
            outputOptions = encoderConfig.getOutputOptions(settings.crf);
        }

        // Create ffmpeg command
        let command = ffmpeg(inputPath)
            // Explicitly map only first video and first audio stream
            // Some iPhone MOV files have multiple streams including invalid ones (codec 'none')
            .addOutputOptions(['-map', '0:v:0', '-map', '0:a:0?'])
            .videoCodec(encoderConfig.codec)
            .addOutputOptions(outputOptions)
            .audioCodec(settings.audioCodec)
            .audioBitrate(settings.audioBitrate)
            // Preserve metadata (GPS location, date, etc) and auto-rotate
            .addOutputOptions(['-map_metadata', '0']);

        // Add format-specific options
        if (outputExt === '.mp4' || outputExt === '.m4v') {
            // Enable faststart for web streaming
            command = command.addOutputOptions(['-movflags', '+faststart']);
        }

        const ffmpegCommand = command
            .on('start', (cmdLine) => {
                if (options.verbose) {
                    console.log('FFmpeg command:', cmdLine);
                }
                if (options.onStart) {
                    options.onStart(ffmpegCommand);
                }
            })
            .on('progress', (progress) => {
                if (options.onProgress) {
                    options.onProgress(progress);
                }
            })
            .on('end', () => {
                let compressedSize = getFileSize(outputPath);
                let note = '';

                // Check if we're converting container formats (e.g., MOV to MP4)
                const inputExt = path.extname(inputPath).toLowerCase();
                const isConvertingFormat = inputExt !== outputExt;

                // Use original file if compressed is larger, but ONLY if not converting formats
                // When converting formats (e.g., MOV to MP4), we must keep the re-encoded version
                // to ensure audio codec compatibility
                if (compressedSize > originalSize && !isConvertingFormat) {
                    try {
                        fs.copyFileSync(inputPath, outputPath);
                        setFileMetadata(inputPath, outputPath);
                        compressedSize = originalSize;
                        note = ' (used original, compressed was larger)';
                    } catch (err) {
                        console.error('Error reverting to original file:', err.message);
                    }
                } else if (compressedSize > originalSize && isConvertingFormat) {
                    note = ' (kept converted file for compatibility)';
                }

                resolve({
                    input: inputPath,
                    output: outputPath,
                    originalSize,
                    compressedSize,
                    originalSizeFormatted: formatFileSize(originalSize),
                    compressedSizeFormatted: formatFileSize(compressedSize),
                    savings: getCompressionRatio(originalSize, compressedSize) + note,
                    encoder: encoderConfig.name,
                    success: true
                });
            })
            .on('error', (err) => {
                reject({
                    input: inputPath,
                    output: outputPath,
                    error: err.message,
                    success: false
                });
            })
            .save(outputPath);
    });
}

/**
 * Get video metadata
 * @param {string} inputPath - Path to video file
 * @returns {Promise<Object>} - Video metadata
 */
function getVideoInfo(inputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                resolve(metadata);
            }
        });
    });
}

/**
 * Check if file extension is supported
 * @param {string} filePath - Path to file
 * @returns {boolean}
 */
function isSupportedFormat(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return SUPPORTED_EXTENSIONS.includes(ext);
}

module.exports = {
    compressVideo,
    getVideoInfo,
    isSupportedFormat,
    detectAvailableEncoders,
    SUPPORTED_EXTENSIONS,
    DEFAULT_SETTINGS
};