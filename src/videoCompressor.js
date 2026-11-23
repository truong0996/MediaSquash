const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const {
    ensureDirCached,
    formatFileSize,
    getCompressionRatio,
    getOptimalThreads,
    setFileMetadataAsync,
    getFFmpegPath,
    getFFprobePath,
    inspectMediaFile,
    probeVideo
} = require('./utils');
const { getEncoderConfig, detectAvailableEncoders } = require('./hwEncoder');

ffmpeg.setFfmpegPath(getFFmpegPath());
ffmpeg.setFfprobePath(getFFprobePath());

const DEFAULT_SETTINGS = {
    encoder: 'auto', // 'auto', 'nvenc', 'amf', 'qsv', 'x264', or 'x265'
    crf: 22,
    preset: 'medium', // For x264/x265 software encoders
    audioCodec: 'aac',
    audioBitrate: '256k',
    threads: 0, // 0 = auto
    videoJobs: 2
};

const SUPPORTED_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.3gp', '.m4v', '.mpeg', '.mpg'];
const HARDWARE_ENCODERS = new Set(['nvenc', 'amf', 'qsv']);

/**
 * Determine whether the source audio stream can be copied losslessly without re-encoding.
 * Copies AAC streams <= 256kbps (or unspecified mobile AAC bitrate) when targeting MP4/M4V/MKV/MOV.
 * @param {Object|null} videoInfo
 * @param {string} outputExt
 * @returns {boolean}
 */
function shouldCopyAudio(videoInfo, outputExt) {
    if (!videoInfo || !['.mp4', '.m4v', '.mov', '.mkv'].includes(outputExt)) {
        return false;
    }
    const audioStream = videoInfo.streams?.find(s => s.codec_type === 'audio');
    if (!audioStream) return false;
    if ((audioStream.codec_name || '').toLowerCase() !== 'aac') return false;

    const bitRate = parseInt(audioStream.bit_rate, 10);
    return isNaN(bitRate) || bitRate <= 256000;
}

/**
 * Run a single FFmpeg encode attempt with cancellation, process tracking, and optional hwaccel.
 */
function runSingleEncode({
    inputPath,
    targetPath,
    outputExt,
    encoderConfig,
    settings,
    threads,
    useHwAccel,
    copyAudio,
    options
}) {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted || (options.shouldCancel && options.shouldCancel())) {
            reject({ input: inputPath, output: targetPath, error: 'Compression cancelled', cancelled: true, success: false });
            return;
        }

        const isSoftware = encoderConfig.type === 'x264' || encoderConfig.type === 'x265';
        const outputOptions = isSoftware
            ? encoderConfig.getOutputOptions(settings.crf, settings.preset, threads)
            : encoderConfig.getOutputOptions(settings.crf);

        let command = ffmpeg(inputPath);

        if (useHwAccel) {
            command = command.inputOptions(['-hwaccel', 'auto']);
        }
        if (!isSoftware && threads > 0) {
            command = command.inputOptions(['-threads', String(threads)]);
        }

        command = command
            .addOutputOptions(['-map', '0:v:0', '-map', '0:a:0?'])
            .videoCodec(encoderConfig.codec)
            .addOutputOptions(outputOptions);

        if (copyAudio) {
            command = command.addOutputOptions(['-c:a', 'copy']);
        } else {
            command = command
                .audioCodec(settings.audioCodec)
                .audioBitrate(settings.audioBitrate);
        }

        command = command.addOutputOptions(['-map_metadata', '0']);

        if (outputExt === '.mp4' || outputExt === '.m4v') {
            command = command.addOutputOptions(['-movflags', '+faststart']);
        }

        let settled = false;
        let ffmpegCommand = null;

        const onAbort = () => {
            if (settled) return;
            settled = true;
            try { ffmpegCommand?.kill('SIGKILL'); } catch {}
            fs.promises.unlink(targetPath).catch(() => {});
            reject({ input: inputPath, output: targetPath, error: 'Compression cancelled', cancelled: true, success: false });
        };

        if (options.signal) {
            options.signal.addEventListener('abort', onAbort, { once: true });
        }

        const cleanupListeners = () => {
            if (options.signal) {
                options.signal.removeEventListener('abort', onAbort);
            }
        };

        ffmpegCommand = command
            .on('start', (cmdLine) => {
                if (options.verbose) {
                    console.log('FFmpeg command:', cmdLine);
                }
                if (options.onStart) {
                    options.onStart(ffmpegCommand);
                }
            })
            .on('progress', (progress) => {
                if (settled) return;
                if (options.signal?.aborted || (options.shouldCancel && options.shouldCancel())) {
                    onAbort();
                    return;
                }
                if (options.onProgress) {
                    options.onProgress(progress);
                }
            })
            .on('end', () => {
                cleanupListeners();
                if (settled) return;
                settled = true;
                resolve();
            })
            .on('error', (err) => {
                cleanupListeners();
                if (settled) return;
                settled = true;
                try { ffmpegCommand?.kill('SIGKILL'); } catch {}

                const cancelled = Boolean(options.signal?.aborted || (options.shouldCancel && options.shouldCancel()));
                if (cancelled) {
                    fs.promises.unlink(targetPath).catch(() => {});
                }
                reject({
                    input: inputPath,
                    output: targetPath,
                    error: cancelled ? 'Compression cancelled' : err.message,
                    cancelled,
                    success: false
                });
            })
            .save(targetPath);
    });
}

/**
 * Losslessly remux an already MP4-compatible stream (h264/hevc + optional aac) into MP4.
 */
function remuxToMp4(inputPath, tempOutPath, videoCodecName) {
    return new Promise((resolve, reject) => {
        const outOpts = ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'copy', '-map_metadata', '0', '-movflags', '+faststart'];
        if (videoCodecName === 'hevc') {
            outOpts.push('-tag:v', 'hvc1');
        }
        ffmpeg(inputPath)
            .addOutputOptions(outOpts)
            .on('end', resolve)
            .on('error', reject)
            .save(tempOutPath);
    });
}

/**
 * Compress a video file using FFmpeg with hardware acceleration support
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output video
 * @param {Object} options - Compression options
 * @returns {Promise<Object>} - Compression result with stats
 */
async function compressVideo(inputPath, outputPath, options = {}) {
    const settings = { ...DEFAULT_SETTINGS, ...options };
    const originalSize = typeof options.originalSize === 'number'
        ? options.originalSize
        : await fs.promises.stat(inputPath).then(s => s.size).catch(() => 0);

    const inspected = await inspectMediaFile(inputPath, originalSize);
    if (inspected.kind === 'invalid') {
        throw {
            input: inputPath,
            output: outputPath,
            error: `Skipped invalid video (${inspected.reason})`,
            success: false
        };
    }
    if (inspected.kind === 'image') {
        throw {
            input: inputPath,
            output: outputPath,
            error: `Input is a ${inspected.format || 'still'} image mislabeled with a video extension`,
            success: false
        };
    }

    if (!options.skipDirCheck) {
        ensureDirCached(path.dirname(outputPath));
    }

    const inputExt = path.extname(inputPath).toLowerCase();
    const outputExt = path.extname(outputPath).toLowerCase();
    const encoderConfig = await getEncoderConfig(settings.encoder);
    const threads = settings.threads > 0 ? settings.threads : getOptimalThreads();
    const videoInfo = options.videoInfo !== undefined
        ? options.videoInfo
        : await probeVideo(inputPath).catch(() => null);
    const copyAudio = shouldCopyAudio(videoInfo, outputExt);

    const samePath = path.resolve(inputPath) === path.resolve(outputPath);
    const targetPath = samePath
        ? `${outputPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${outputExt}`
        : outputPath;

    const isHardware = HARDWARE_ENCODERS.has(encoderConfig.type);
    const tryHwAccel = isHardware && !options.disableHwAccel;

    try {
        try {
            await runSingleEncode({
                inputPath,
                targetPath,
                outputExt,
                encoderConfig,
                settings,
                threads,
                useHwAccel: tryHwAccel,
                copyAudio,
                options
            });
        } catch (err) {
            if (err?.cancelled || !tryHwAccel) {
                throw err;
            }
            // Retry once with software decode if GPU hardware decode failed on an exotic input format
            await fs.promises.unlink(targetPath).catch(() => {});
            await runSingleEncode({
                inputPath,
                targetPath,
                outputExt,
                encoderConfig,
                settings,
                threads,
                useHwAccel: false,
                copyAudio,
                options
            });
        }

        if (samePath) {
            await fs.promises.rename(targetPath, outputPath);
        }

        let compressedSize = await fs.promises.stat(outputPath).then(s => s.size).catch(() => 0);
        let note = '';
        const isConvertingFormat = inputExt !== outputExt;

        if (compressedSize > originalSize && !isConvertingFormat) {
            try {
                if (!samePath) {
                    await fs.promises.copyFile(inputPath, outputPath);
                }
                await setFileMetadataAsync(inputPath, outputPath);
                compressedSize = originalSize;
                note = ' (used original, compressed was larger)';
            } catch (err) {
                console.error('Error reverting to original file:', err.message);
            }
        } else if (compressedSize > originalSize && isConvertingFormat) {
            const vCodec = (videoInfo?.streams?.find(s => s.codec_type === 'video')?.codec_name || '').toLowerCase();
            const aStream = videoInfo?.streams?.find(s => s.codec_type === 'audio');
            const aCodec = (aStream?.codec_name || '').toLowerCase();
            const canRemux = (outputExt === '.mp4' || outputExt === '.m4v') &&
                (vCodec === 'h264' || vCodec === 'hevc') &&
                (!aStream || aCodec === 'aac');

            if (canRemux) {
                const remuxTmp = `${outputPath}.remux_${Date.now()}${outputExt}`;
                try {
                    await remuxToMp4(inputPath, remuxTmp, vCodec);
                    const remuxSize = await fs.promises.stat(remuxTmp).then(s => s.size).catch(() => 0);
                    if (remuxSize > 0 && remuxSize < compressedSize) {
                        await fs.promises.rename(remuxTmp, outputPath);
                        compressedSize = remuxSize;
                        note = ' (remuxed losslessly, re-encode was larger)';
                    } else {
                        await fs.promises.unlink(remuxTmp).catch(() => {});
                        note = ' (kept converted file for compatibility)';
                    }
                } catch {
                    await fs.promises.unlink(remuxTmp).catch(() => {});
                    note = ' (kept converted file for compatibility)';
                }
            } else {
                note = ' (kept converted file for compatibility)';
            }
        }

        return {
            input: inputPath,
            output: outputPath,
            originalSize,
            compressedSize,
            originalSizeFormatted: formatFileSize(originalSize),
            compressedSizeFormatted: formatFileSize(compressedSize),
            savings: getCompressionRatio(originalSize, compressedSize) + note,
            encoder: encoderConfig.name,
            audioCopied: copyAudio,
            success: true
        };
    } catch (err) {
        if (samePath) {
            await fs.promises.unlink(targetPath).catch(() => {});
        }
        throw err;
    }
}

/**
 * Get video metadata (cached via probeVideo)
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
 * Calculate adaptive CRF based on video properties (portrait-aware via short edge).
 * Higher CRF = smaller file, lower quality
 * @param {number} baseCrf - Base CRF (default 22)
 * @param {Object} videoInfo - Video metadata from ffprobe
 * @returns {number}
 */
function getAdaptiveCrf(baseCrf, videoInfo) {
    let crf = baseCrf || 22;

    try {
        const videoStream = videoInfo?.streams?.find(s => s.codec_type === 'video');
        if (!videoStream) return crf;

        const width = videoStream.width || 0;
        const height = videoStream.height || 0;
        const shortEdge = (width > 0 && height > 0) ? Math.min(width, height) : Math.max(width, height);
        const duration = parseFloat(videoStream.duration) || parseFloat(videoInfo.format?.duration) || 0;

        if (shortEdge >= 2160) {
            crf += 2;
        } else if (shortEdge >= 1440) {
            crf += 1;
        } else if (shortEdge > 0 && shortEdge <= 480) {
            crf -= 2;
        } else if (shortEdge > 0 && shortEdge <= 720) {
            crf -= 1;
        }

        if (duration > 600) {
            crf += 1;
        }

        crf = Math.max(0, Math.min(51, crf));
    } catch {
        return baseCrf || 22;
    }

    return crf;
}

/**
 * Get video info with adaptive CRF (uses cached probeVideo)
 * @param {string} inputPath - Path to video
 * @param {number} baseCrf - Base CRF
 * @returns {Promise<{crf: number, width: number, height: number, duration: number}>}
 */
async function getVideoInfoWithCrf(inputPath, baseCrf) {
    const info = await probeVideo(inputPath);
    if (!info) {
        throw new Error(`Failed to probe video: ${inputPath}`);
    }
    const videoStream = info.streams?.find(s => s.codec_type === 'video');

    return {
        crf: getAdaptiveCrf(baseCrf, info),
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        duration: parseFloat(videoStream?.duration) || parseFloat(info.format?.duration) || 0
    };
}

module.exports = {
    compressVideo,
    getVideoInfo,
    getVideoInfoWithCrf,
    getAdaptiveCrf,
    shouldCopyAudio,
    isSupportedFormat,
    detectAvailableEncoders,
    SUPPORTED_EXTENSIONS,
    DEFAULT_SETTINGS
};
