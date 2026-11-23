#!/usr/bin/env node

const os = require('os');
if (!process.env.UV_THREADPOOL_SIZE) {
    const cpuCount = os.cpus().length || 4;
    process.env.UV_THREADPOOL_SIZE = String(Math.min(Math.max(cpuCount, 8), 16));
}

const { program } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');
const { compressImage, configureSharpConcurrency } = require('./imageCompressor');
const { compressVideo, getAdaptiveCrf } = require('./videoCompressor');
const { getEncoderConfig } = require('./hwEncoder');
const { shutdownHeicPool } = require('./heicWorker');
const {
    isImage,
    isVideo,
    generateOutputPath,
    normalizeOutputExtension,
    formatFileSize,
    getCompressionRatio,
    getOptimalConcurrency,
    getRecommendedVideoConcurrency,
    getOptimalVideoThreads,
    parallelProcess,
    scanFilesAsync,
    ensureDirCached,
    getCaptureDate,
    formatDateForFilename,
    formatDateForFolder,
    setFileMetadataAsync,
    clearCaptureDateCache,
    inspectMediaFile,
    probeVideo,
    evictProbeCache,
    validateQuality,
    validateCrf,
    validateImageFormat,
    validateEncoder
} = require('./utils');

const packageJson = require('../package.json');
const activeProcesses = new Set();

function cleanup() {
    if (activeProcesses.size > 0) {
        console.log(chalk.yellow(`\n🧹 Cleaning up ${activeProcesses.size} active FFmpeg process(es)...`));
        for (const proc of activeProcesses) {
            try {
                proc.kill('SIGKILL');
            } catch {}
        }
        activeProcesses.clear();
    }
}

process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
});

process.on('exit', cleanup);

async function getFinalOutputPath(inputPath, options, defaultOutputPath, reservedPaths = null, actualType = null) {
    const imageFormat = validateImageFormat(options.imageFormat || 'webp');
    const normalizedPath = normalizeOutputExtension(defaultOutputPath, imageFormat, actualType);

    let candidateBase = normalizedPath;
    if (options.rename) {
        const date = await getCaptureDate(inputPath);
        if (date) {
            const newName = formatDateForFilename(date);
            const ext = path.extname(normalizedPath);
            const dir = path.dirname(normalizedPath);
            candidateBase = path.join(dir, `${newName}${ext}`);
        }
    }

    const ext = path.extname(candidateBase);
    const name = path.basename(candidateBase, ext);
    const dir = path.dirname(candidateBase);

    let finalPath = candidateBase;
    let counter = 1;
    // Synchronous loop guarantees atomic collision-free reservation across concurrent workers
    while ((reservedPaths && reservedPaths.has(finalPath)) || fs.existsSync(finalPath)) {
        finalPath = path.join(dir, `${name}_${counter}${ext}`);
        counter++;
    }

    if (reservedPaths) reservedPaths.add(finalPath);
    return finalPath;
}

async function processDirectory(inputDir, options, type = 'all') {
    const startTime = Date.now();
    if (options.renameOnly) options.rename = true;

    try {
        const inputPath = path.resolve(inputDir);

        if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isDirectory()) {
            console.error(chalk.red(`Error: Directory not found: ${inputPath}`));
            process.exit(1);
        }

        const outputDir = options.output ? path.resolve(options.output) : path.join(inputPath, 'compressed');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        clearCaptureDateCache();

        const extFilter = (filePath) => isImage(filePath) || isVideo(filePath);
        const scannedFiles = await scanFilesAsync(inputPath, extFilter, Boolean(options.recursive));
        const allItems = scannedFiles.filter(item => {
            if (type === 'image') return item.type === 'image';
            if (type === 'video') return item.type === 'video';
            return true;
        });

        if (allItems.length === 0) {
            console.log(chalk.yellow(`No supported ${type === 'all' ? 'image or video' : type} files found.`));
            return;
        }

        const imageItems = allItems.filter(item => item.type === 'image');
        const videoItems = allItems.filter(item => item.type === 'video');
        const reservedOutputPaths = new Set();
        const imageFormat = validateImageFormat(options.imageFormat || 'webp');
        const quality = validateQuality(options.quality);

        const determineTargetFile = async (filePath, actualType) => {
            let targetDir;
            if (options.flatten) {
                targetDir = outputDir;
            } else if (options.organize) {
                const date = await getCaptureDate(filePath);
                const folderName = formatDateForFolder(date);
                targetDir = path.join(outputDir, folderName);
            } else {
                const relativePath = path.relative(inputPath, path.dirname(filePath));
                targetDir = path.join(outputDir, relativePath);
            }

            ensureDirCached(targetDir);
            const baseOutputPath = path.join(targetDir, path.basename(filePath));
            return getFinalOutputPath(filePath, { ...options, imageFormat }, baseOutputPath, reservedOutputPaths, actualType);
        };

        const concurrency = options.jobs ? Math.max(1, parseInt(options.jobs, 10) || 1) : getOptimalConcurrency();
        const cpuInfo = `${os.cpus().length} cores detected`;

        let structureType = 'Mirrored Input Structure';
        if (options.flatten) structureType = 'Flattened (All in Root)';
        else if (options.organize) structureType = 'Organized by Date (YYYY-MM)';

        console.log(chalk.blue(`📁 Found ${allItems.length} file(s) to ${options.renameOnly ? 'organize' : 'compress'}`));
        if (type !== 'video') console.log(chalk.gray(`   Images: ${imageItems.length}`));
        if (type !== 'image') console.log(chalk.gray(`   Videos: ${videoItems.length}`));
        console.log(chalk.gray(`   Recursive Scan: ${options.recursive ? 'Yes' : 'No'}`));
        console.log(chalk.gray(`   Output Structure: ${structureType}`));
        console.log(chalk.gray(`   Mode: ${options.renameOnly ? 'RENAME & COPY ONLY' : 'COMPRESS'}`));
        console.log(chalk.gray(`   CPU: ${cpuInfo} | Parallel jobs: ${concurrency}\n`));

        let totalOriginal = 0;
        let totalCompressed = 0;
        let successCount = 0;
        let failCount = 0;

        if (imageItems.length > 0) {
            configureSharpConcurrency(concurrency);
            console.log(chalk.blue(`🖼️  Processing ${imageItems.length} image(s) in parallel (${concurrency} jobs)....\n`));

            await parallelProcess(
                imageItems,
                async (item) => {
                    const filePath = item.path;
                    const fileName = path.basename(filePath);
                    let currentOutputPath = null;
                    try {
                        currentOutputPath = await determineTargetFile(filePath, 'image');
                        const inputStat = await fs.promises.stat(filePath);

                        if (options.renameOnly) {
                            const fmt = (item.actualFormat || path.extname(filePath).slice(1)).toLowerCase();
                            if (fmt === 'heic' || fmt === 'heif') {
                                const result = await compressImage(filePath, currentOutputPath, {
                                    quality,
                                    originalSize: inputStat.size,
                                    actualFormat: item.actualFormat,
                                    skipDirCheck: true
                                });
                                await setFileMetadataAsync(filePath, currentOutputPath, inputStat);
                                totalOriginal += result.originalSize;
                                totalCompressed += result.compressedSize;
                                successCount++;
                                console.log(chalk.green(`   ✓ ${path.basename(currentOutputPath)}: Converted from HEIC`));
                                return;
                            }

                            await fs.promises.copyFile(filePath, currentOutputPath);
                            await setFileMetadataAsync(filePath, currentOutputPath, inputStat);
                            totalOriginal += inputStat.size;
                            totalCompressed += inputStat.size;
                            successCount++;
                            console.log(chalk.green(`   ✓ ${path.basename(currentOutputPath)}: Copied/Renamed`));
                            return;
                        }

                        const result = await compressImage(filePath, currentOutputPath, {
                            quality,
                            originalSize: inputStat.size,
                            actualFormat: item.actualFormat,
                            skipDirCheck: true
                        });
                        await setFileMetadataAsync(filePath, currentOutputPath, inputStat);

                        totalOriginal += result.originalSize;
                        totalCompressed += result.compressedSize;
                        successCount++;

                        console.log(chalk.green(`   ✓ ${path.basename(currentOutputPath)}: ${result.originalSizeFormatted} → ${result.compressedSizeFormatted} (${result.savings} saved)`));
                    } catch (error) {
                        console.log(chalk.yellow(`   ⚠ ${fileName}: Compression failed (${error.message}). Copying original instead...`));
                        if (!currentOutputPath) currentOutputPath = await determineTargetFile(filePath, 'image');
                        const inputStat = await fs.promises.stat(filePath);
                        if (inputStat.size > 0) {
                            await fs.promises.copyFile(filePath, currentOutputPath);
                            await setFileMetadataAsync(filePath, currentOutputPath, inputStat);
                        }

                        totalOriginal += inputStat.size;
                        totalCompressed += inputStat.size;
                        successCount++;
                        failCount++;
                    }
                },
                concurrency,
                { collectResults: false }
            );
        }

        if (videoItems.length > 0) {
            const requestedEncoder = validateEncoder(options.encoder);
            const encoderConfig = await getEncoderConfig(requestedEncoder);
            const videoConcurrency = getRecommendedVideoConcurrency(videoItems.length, encoderConfig.type);
            const videoThreads = getOptimalVideoThreads(videoConcurrency, {
                encoderType: encoderConfig.type,
                overlapWithImages: false
            });
            const baseCrf = validateCrf(options.crf);

            // Largest-First (LPT) scheduling avoids tail stragglers
            const sortedVideos = [...videoItems].sort((a, b) => (b.size || 0) - (a.size || 0));

            console.log(chalk.blue(`\n🎬 Processing videos in parallel (${videoConcurrency} jobs, ${videoThreads} threads/job, ${encoderConfig.type})...\n`));

            await parallelProcess(
                sortedVideos,
                async (item) => {
                    const filePath = item.path;
                    const fileName = path.basename(filePath);
                    let currentOutputPath = null;
                    let currentCmd = null;
                    try {
                        currentOutputPath = await determineTargetFile(filePath, 'video');
                        const inputStat = await fs.promises.stat(filePath);

                        if (options.renameOnly) {
                            await fs.promises.copyFile(filePath, currentOutputPath);
                            await setFileMetadataAsync(filePath, currentOutputPath, inputStat);
                            totalOriginal += inputStat.size;
                            totalCompressed += inputStat.size;
                            successCount++;
                            console.log(chalk.green(`   ✓ ${path.basename(currentOutputPath)}: Copied/Renamed`));
                            return;
                        }

                        console.log(chalk.gray(`   Processing: ${fileName}...`));
                        let videoInfo = null;
                        let adaptiveCrf = baseCrf;
                        try {
                            videoInfo = await probeVideo(filePath);
                            if (videoInfo) adaptiveCrf = getAdaptiveCrf(baseCrf, videoInfo);
                        } catch {}

                        const result = await compressVideo(filePath, currentOutputPath, {
                            crf: adaptiveCrf,
                            preset: options.preset || 'medium',
                            encoder: requestedEncoder,
                            threads: videoThreads,
                            originalSize: inputStat.size,
                            skipDirCheck: true,
                            videoInfo,
                            onStart: (cmd) => {
                                currentCmd = cmd;
                                activeProcesses.add(cmd);
                            }
                        });

                        await setFileMetadataAsync(filePath, currentOutputPath, inputStat);

                        totalOriginal += result.originalSize;
                        totalCompressed += result.compressedSize;
                        successCount++;

                        console.log(chalk.green(`   ✓ ${path.basename(currentOutputPath)}: ${result.originalSizeFormatted} → ${result.compressedSizeFormatted} (${result.savings} saved)`));
                    } catch (error) {
                        console.log(chalk.yellow(`   ⚠ ${fileName}: Compression failed (${error.message || error.error || 'Unknown error'}). Copying original...`));
                        if (!currentOutputPath) currentOutputPath = await determineTargetFile(filePath, 'video');
                        const inputStat = await fs.promises.stat(filePath);
                        if (inputStat.size > 0) {
                            await fs.promises.copyFile(filePath, currentOutputPath);
                            await setFileMetadataAsync(filePath, currentOutputPath, inputStat);
                        }

                        totalOriginal += inputStat.size;
                        totalCompressed += inputStat.size;
                        successCount++;
                        failCount++;
                    } finally {
                        if (currentCmd) activeProcesses.delete(currentCmd);
                        evictProbeCache(filePath);
                    }
                },
                videoConcurrency,
                { collectResults: false }
            );
        }

        const endTime = Date.now();
        const durationSeconds = ((endTime - startTime) / 1000).toFixed(1);

        console.log(chalk.blue('\n📊 Summary Report'));
        console.log(chalk.white(`   Files processed:  ${successCount}/${allItems.length}`));
        if (failCount > 0) console.log(chalk.red(`   Failed:           ${failCount}`));
        console.log(chalk.white(`   Time taken:       ${durationSeconds}s`));
        console.log(chalk.white(`   Total original:   ${formatFileSize(totalOriginal)}`));
        console.log(chalk.white(`   Total compressed: ${formatFileSize(totalCompressed)}`));
        console.log(chalk.cyan(`   Total saved:      ${formatFileSize(totalOriginal - totalCompressed)} (${getCompressionRatio(totalOriginal, totalCompressed)} reduction)`));
        console.log(chalk.gray(`   Output directory: ${outputDir}`));
    } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
    } finally {
        await shutdownHeicPool().catch(() => {});
    }
}

program
    .name('compress')
    .description('CLI tool to compress images and videos')
    .version(packageJson.version);

program
    .command('image <input>')
    .description('Compress an image file OR directory of images (supports: jpg, png, webp, avif, tiff, gif, heic)')
    .option('-o, --output <path>', 'Output file path or directory')
    .option('-q, --quality <number>', 'Quality level (1-100, default: 88)', '88')
    .option('--image-format <format>', 'Target image format: jpeg, webp, avif (default: webp)', 'webp')
    .option('--rename', 'Rename file based on capture date (yyyymmdd-hhmmss)', false)
    .option('--rename-only', 'Rename and copy files without compressing', false)
    .option('-r, --recursive', 'Search directories recursively (if input is directory)', false)
    .option('--flatten', 'Put all files directly in output folder (no subfolders)', false)
    .option('--organize', 'Organize output into folders by date (YYYY-MM)', false)
    .option('-j, --jobs <number>', 'Parallel jobs (if input is directory)')
    .action(async (input, options) => {
        try {
            const inputPath = path.resolve(input);

            if (!fs.existsSync(inputPath)) {
                console.error(chalk.red(`Error: File/Directory not found: ${inputPath}`));
                process.exit(1);
            }

            if (fs.statSync(inputPath).isDirectory()) {
                await processDirectory(inputPath, options, 'image');
                return;
            }

            if (!isImage(inputPath)) {
                console.error(chalk.red('Error: Input file is not a supported image format'));
                process.exit(1);
            }

            let currentOutputPath = null;
            try {
                currentOutputPath = await getFinalOutputPath(inputPath, options, generateOutputPath(inputPath, options.output));

                if (options.renameOnly) {
                    await fs.promises.copyFile(inputPath, currentOutputPath);
                    await setFileMetadataAsync(inputPath, currentOutputPath);
                    console.log(chalk.green('\n✅ File copied and renamed (No compression).'));
                    return;
                }

                console.log(chalk.blue('🖼️  Compressing image...'));
                console.log(chalk.gray(`   Input:  ${inputPath}`));
                console.log(chalk.gray(`   Output: ${currentOutputPath}`));

                const result = await compressImage(inputPath, currentOutputPath, { quality: validateQuality(options.quality) });
                await setFileMetadataAsync(inputPath, currentOutputPath);

                console.log(chalk.green('\n✅ Compression complete!'));
                console.log(chalk.white(`   Original:   ${result.originalSizeFormatted}`));
                console.log(chalk.white(`   Compressed: ${result.compressedSizeFormatted}`));
                console.log(chalk.cyan(`   Saved:      ${result.savings}`));
            } catch (error) {
                console.log(chalk.yellow(`\n⚠ Compression failed (${error.message}). Copying original instead...`));
                if (!currentOutputPath) {
                    currentOutputPath = await getFinalOutputPath(inputPath, options, generateOutputPath(inputPath, options.output));
                }
                await fs.promises.copyFile(inputPath, currentOutputPath);
                await setFileMetadataAsync(inputPath, currentOutputPath);
                console.log(chalk.green('✅ Original file copied to output with metadata preserved.'));
            } finally {
                await shutdownHeicPool().catch(() => {});
            }
        } catch (error) {
            console.error(chalk.red(`Error: ${error.message}`));
            process.exit(1);
        }
    });

program
    .command('video <input>')
    .description('Compress a video file OR directory of videos (supports: mp4, mkv, avi, mov, wmv, flv, webm, 3gp)')
    .option('-o, --output <path>', 'Output file path or directory')
    .option('-c, --crf <number>', 'CRF value (0-51, lower = better quality, default: 22)', '22')
    .option('-p, --preset <preset>', 'Encoding preset for CPU (ultrafast, fast, medium, slow, veryslow)', 'medium')
    .option('-e, --encoder <encoder>', 'Video encoder: auto, nvenc, qsv, x264, x265 (default: auto)', 'auto')
    .option('--rename', 'Rename file based on capture date (yyyymmdd-hhmmss)', false)
    .option('--rename-only', 'Rename and copy files without compressing', false)
    .option('-r, --recursive', 'Search directories recursively (if input is directory)', false)
    .option('--flatten', 'Put all files directly in output folder (no subfolders)', false)
    .option('--organize', 'Organize output into folders by date (YYYY-MM)', false)
    .action(async (input, options) => {
        try {
            const inputPath = path.resolve(input);

            if (!fs.existsSync(inputPath)) {
                console.error(chalk.red(`Error: File/Directory not found: ${inputPath}`));
                process.exit(1);
            }

            if (fs.statSync(inputPath).isDirectory()) {
                await processDirectory(inputPath, options, 'video');
                return;
            }

            if (!isVideo(inputPath)) {
                console.error(chalk.red('Error: Input file is not a supported video format'));
                process.exit(1);
            }

            let currentOutputPath = null;
            try {
                currentOutputPath = await getFinalOutputPath(inputPath, options, generateOutputPath(inputPath, options.output));

                if (options.renameOnly) {
                    await fs.promises.copyFile(inputPath, currentOutputPath);
                    await setFileMetadataAsync(inputPath, currentOutputPath);
                    console.log(chalk.green('\n✅ File copied and renamed (No compression).'));
                    return;
                }

                const crf = validateCrf(options.crf);
                const encoder = validateEncoder(options.encoder);

                console.log(chalk.blue('🎬 Compressing video...'));
                console.log(chalk.gray(`   Input:  ${inputPath}`));
                console.log(chalk.gray(`   Output: ${currentOutputPath}`));
                console.log(chalk.gray(`   CRF:    ${crf} | Encoder: ${encoder}`));

                const result = await compressVideo(inputPath, currentOutputPath, {
                    crf,
                    preset: options.preset,
                    encoder,
                    onStart: (cmd) => activeProcesses.add(cmd),
                    onProgress: (progress) => {
                        if (progress.percent) {
                            process.stdout.write(chalk.gray(`\r   Progress: ${progress.percent.toFixed(1)}%`));
                        }
                    }
                });

                activeProcesses.clear();
                await setFileMetadataAsync(inputPath, currentOutputPath);

                console.log(chalk.green('\n\n✅ Compression complete!'));
                console.log(chalk.white(`   Original:   ${result.originalSizeFormatted}`));
                console.log(chalk.white(`   Compressed: ${result.compressedSizeFormatted}`));
                console.log(chalk.cyan(`   Saved:      ${result.savings}`));
            } catch (error) {
                console.log(chalk.yellow(`\n\n⚠ Compression failed (${error.message || error.error}). Copying original instead...`));
                if (!currentOutputPath) {
                    currentOutputPath = await getFinalOutputPath(inputPath, options, generateOutputPath(inputPath, options.output));
                }
                await fs.promises.copyFile(inputPath, currentOutputPath);
                await setFileMetadataAsync(inputPath, currentOutputPath);
                console.log(chalk.green('✅ Original file copied to output with metadata preserved.'));
            }
        } catch (error) {
            console.error(chalk.red(`\nError: ${error.message || error.error}`));
            process.exit(1);
        }
    });

program
    .command('all <inputDir>')
    .description('Compress all images and videos in a directory')
    .option('-o, --output <dir>', 'Output directory')
    .option('-q, --quality <number>', 'Image quality (1-100, default: 88)', '88')
    .option('--image-format <format>', 'Target image format: jpeg, webp, avif (default: webp)', 'webp')
    .option('-c, --crf <number>', 'Video CRF (0-51, default: 22)', '22')
    .option('-e, --encoder <encoder>', 'Video encoder: auto, nvenc, qsv, x264, x265 (default: auto)', 'auto')
    .option('-j, --jobs <number>', `Parallel jobs for images (default: auto)`)
    .option('-r, --recursive', 'Search directories recursively', false)
    .option('--flatten', 'Put all files directly in output folder (no subfolders)', false)
    .option('--organize', 'Organize output into folders by date (YYYY-MM)', false)
    .option('-p, --preset <preset>', 'Encoding preset for x264/x265 (ultrafast, fast, medium, slow, veryslow)', 'medium')
    .option('--rename', 'Rename files based on capture date (yyyymmdd-hhmmss)', false)
    .option('--rename-only', 'Rename and copy files without compressing', false)
    .action(async (inputDir, options) => {
        await processDirectory(inputDir, options, 'all');
    });

program.parse();
