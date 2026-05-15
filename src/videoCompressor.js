const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { ensureDirectoryExists, getFileSize, formatFileSize, getCompressionRatio, getOptimalThreads, setFileMetadata, getFFmpegPath } = require('./utils');
const { getEncoderConfig, detectAvailableEncoders } = require('./hwEncoder');

// Set ffmpeg path
ffmpeg.setFfmpegPath(getFFmpegPath());

// Default compression settings
const DEFAULT_SETTINGS = {
    encoder: 'auto', // 'auto', 'nvenc', 'amf', 'qsv', 'x264', or 'x265'
    crf: 22,
    preset: 'medium', // For x264/x265 software encoders
    audioCodec: 'aac',
    audioBitrate: '256k',
    threads: 0, // 0 = auto (for x264/x265 software encoders)
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

    // Calculate optimal threads for software encoders (x264/x265)
    const threads = settings.threads || getOptimalThreads();

    let isCancelled = false;

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
                // Check for cancellation
                if (options.shouldCancel && options.shouldCancel()) {
                    isCancelled = true;
                    ffmpegCommand.kill('SIGKILL');
                    reject(new Error('Compression cancelled'));
                    return;
                }
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
                // Clean up on error
                try { ffmpegCommand.kill(); } catch {}
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

/**
 * Calculate adaptive CRF based on video properties
 * Higher CRF = smaller file, lower quality
 * @param {number} baseCrf - Base CRF (default 22)
 * @param {Object} videoInfo - Video metadata from ffprobe
 * @returns {number}
 */
function getAdaptiveCrf(baseCrf, videoInfo) {
    let crf = baseCrf || 22;

    try {
        const videoStream = videoInfo.streams?.find(s => s.codec_type === 'video');
        if (!videoStream) return crf;

        const width = videoStream.width || 0;
        const height = videoStream.height || 0;
        const duration = videoStream.duration || 0;

        // Resolution adjustment
        if (height >= 2160) {
            // 4K: more pixels = artifacts less visible
            crf += 2;
        } else if (height >= 1440) {
            // 2K/QHD: slightly more pixels
            crf += 1;
        } else if (height <= 480) {
            // 480p or less: fewer pixels = artifacts more visible
            crf -= 2;
        } else if (height <= 720) {
            // 720p: standard
            crf -= 1;
        }

        // Duration adjustment
        if (duration > 600) {
            // >10 min: more savings on longer videos
            crf += 1;
        }

        // Clamp CRF to valid range
        crf = Math.max(0, Math.min(51, crf));
    } catch {
        // On error, return base CRF
        return baseCrf || 22;
    }

    return crf;
}

/**
 * Get video info with adaptive CRF
 * @param {string} inputPath - Path to video
 * @param {number} baseCrf - Base CRF
 * @returns {Promise<{crf: number, width: number, height: number, duration: number}>}
 */
async function getVideoInfoWithCrf(inputPath, baseCrf) {
    const info = await getVideoInfo(inputPath);
    const videoStream = info.streams?.find(s => s.codec_type === 'video');

    return {
        crf: getAdaptiveCrf(baseCrf, info),
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        duration: parseFloat(videoStream?.duration) || 0
    };
}

module.exports = {
    compressVideo,
    getVideoInfo,
    getVideoInfoWithCrf,
    getAdaptiveCrf,
    isSupportedFormat,
    detectAvailableEncoders,
    SUPPORTED_EXTENSIONS,
    DEFAULT_SETTINGS
};