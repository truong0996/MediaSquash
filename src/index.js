#!/usr/bin/env node

const { program } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { compressImage } = require('./imageCompressor');
const { compressVideo } = require('./videoCompressor');
const { isImage, isVideo, generateOutputPath, normalizeOutputExtension, formatFileSize, getCompressionRatio, getOptimalConcurrency, parallelProcess, getFilesRecursive, ensureDirectoryExists, getCaptureDate, formatDateForFilename, formatDateForFolder, setFileMetadata } = require('./utils');

// Package info
const packageJson = require('../package.json');

// Track active FFmpeg processes for cleanup
const activeProcesses = new Set();

/**
 * Clean up active processes on exit
 */
function cleanup() {
    if (activeProcesses.size > 0) {
        console.log(chalk.yellow(`\n🧹 Cleaning up ${activeProcesses.size} active FFmpeg process(es)...`));
        for (const proc of activeProcesses) {
            try {
                proc.kill('SIGKILL');
            } catch (err) {
                // Ignore errors during cleanup
            }
        }
        activeProcesses.clear();
    }
}

// Handle process signals
process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
});

async function getFinalOutputPath(inputPath, options, defaultOutputPath) {
    // Use the target image format if provided
    const imageFormat = options.imageFormat || 'webp';
    const normalizedPath = normalizeOutputExtension(defaultOutputPath, imageFormat);

    if (!options.rename) return normalizedPath;

    // If rename is on, we recalculate the filename part
    const date = await getCaptureDate(inputPath);
    if (!date) return normalizedPath;

    const newName = formatDateForFilename(date);
    const ext = path.extname(normalizedPath); // Use normalized extension
    const dir = path.dirname(normalizedPath); // Use the directory determined by the caller

    let finalPath = path.join(dir, `${newName}${ext}`);
    let counter = 1;

    while (fs.existsSync(finalPath)) {
        finalPath = path.join(dir, `${newName}(${counter})${ext}`);
        counter++;
    }

    return finalPath;
}

process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
});

process.on('exit', cleanup);

// NEW HELPER: Generic directory processor to support batching in 'image', 'video', and 'all' commands
async function processDirectory(inputDir, options, type = 'all') {
    const startTime = Date.now();

    // Force renaming if rename-only is used
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

        // Define filter based on type
        const filter = (filePath) => {
            if (type === 'image') return isImage(filePath);
            if (type === 'video') return isVideo(filePath);
            return isImage(filePath) || isVideo(filePath);
        };

        const allFiles = options.recursive
            ? getFilesRecursive(inputPath, filter)
            : fs.readdirSync(inputPath)
                .map(f => path.join(inputPath, f))
                .filter(f => fs.statSync(f).isFile() && filter(f));

        if (allFiles.length === 0) {
            console.log(chalk.yellow(`No supported ${type === 'all' ? 'image or video' : type} files found.`));
            return;
        }

        // Separate images and videos
        const imageFiles = allFiles.filter(f => isImage(f));
        const videoFiles = allFiles.filter(f => isVideo(f));

        // Helper to determine output directory per file
        const determineTargetFile = async (filePath) => {
            let targetDir;

            if (options.flatten) {
                // FLATTEN: All files go directly to output root (No subfolders)
                targetDir = outputDir;
            } else if (options.organize) {
                // ORGANIZE: YYYY-MM folders
                const date = await getCaptureDate(filePath);
                const folderName = formatDateForFolder(date);
                targetDir = path.join(outputDir, folderName);
            } else {
                // DEFAULT: Mirror input directory structure
                const relativePath = path.relative(inputPath, path.dirname(filePath));
                targetDir = path.join(outputDir, relativePath);
            }

            ensureDirectoryExists(path.join(targetDir, 'dummy.txt')); // Ensure dir exists

            // Calculate base filename (e.g. image.jpg)
            const baseOutputPath = path.join(targetDir, path.basename(filePath));

            // Apply renaming if requested
            // OR if flattening caused a collision (getFinalOutputPath handles collisions if rename is on, 
            // but we need to handle collisions even if rename is OFF when flattening)

            if (options.rename) {
                return await getFinalOutputPath(filePath, options, baseOutputPath);
            } else {
                // Normalize extension for consistent format (.jpeg for images, .mp4 for videos)
                const imageFormat = options.imageFormat || 'webp';
                const normalizedPath = normalizeOutputExtension(baseOutputPath, imageFormat);

                // Handle name collisions in Flatten mode without renaming by date
                let finalPath = normalizedPath;
                let counter = 1;
                const ext = path.extname(normalizedPath);
                const name = path.basename(normalizedPath, ext);
                const dir = path.dirname(normalizedPath);

                while (fs.existsSync(finalPath)) {
                    finalPath = path.join(dir, `${name}(${counter})${ext}`);
                    counter++;
                }
                return finalPath;
            }
        };

        // Calculate concurrency
        const concurrency = options.jobs ? parseInt(options.jobs, 10) : getOptimalConcurrency();
        const cpuInfo = `${os.cpus().length} cores detected`;

        let structureType = 'Mirrored Input Structure';
        if (options.flatten) structureType = 'Flattened (All in Root)';
        else if (options.organize) structureType = 'Organized by Date (YYYY-MM)';

        console.log(chalk.blue(`📁 Found ${allFiles.length} file(s) to ${options.renameOnly ? 'organize' : 'compress'}`));
        if (type !== 'video') console.log(chalk.gray(`   Images: ${imageFiles.length}`));
        if (type !== 'image') console.log(chalk.gray(`   Videos: ${videoFiles.length}`));
        console.log(chalk.gray(`   Recursive Scan: ${options.recursive ? 'Yes' : 'No'}`));
        console.log(chalk.gray(`   Output Structure: ${structureType}`));
        console.log(chalk.gray(`   Mode: ${options.renameOnly ? 'RENAME & COPY ONLY' : 'COMPRESS'}`));
        console.log(chalk.gray(`   CPU: ${cpuInfo} | Parallel jobs: ${concurrency}\n`));

        let totalOriginal = 0;
        let totalCompressed = 0;
        let successCount = 0;
        let failCount = 0;

        // Process images in parallel (they're fast and CPU-bound)
        if (imageFiles.length > 0) {
            console.log(chalk.blue(`🖼️  Processing ${imageFiles.length} image(s) in parallel (${concurrency} jobs)....\n`));

            const imageResults = await parallelProcess(
                imageFiles,
                async (filePath) => {
                    const fileName = path.basename(filePath);
                    try {
                        const currentOutputPath = await determineTargetFile(filePath);

                        if (options.renameOnly) {
                            const ext = path.extname(filePath).toLowerCase();

                            // HEIC/HEIF files must be converted even in renameOnly mode
                            if (ext === '.heic' || ext === '.heif') {
                                const result = await compressImage(filePath, currentOutputPath, {
                                    quality: parseInt(options.quality, 10)
                                });
                                setFileMetadata(filePath, currentOutputPath);
                                totalOriginal += result.originalSize;
                                totalCompressed += result.compressedSize;
                                successCount++;
                                console.log(chalk.green(`   ✓ ${path.basename(currentOutputPath)}: Converted from HEIC`));
                                return result;
                            }

                            // Other formats: just copy with new extension
                            fs.copyFileSync(filePath, currentOutputPath);
                            setFileMetadata(filePath, currentOutputPath);
                            const size = fs.statSync(filePath).size;
                            totalOriginal += size;
                            totalCompressed += size; // No savings
                            successCount++;
                            console.log(chalk.green(`   ✓ ${path.basename(currentOutputPath)}: Copied/Renamed`));
                            return { originalSize: size, compressedSize: size, savings: '0%' };
                        }

                        const result = await compressImage(filePath, currentOutputPath, {
                            quality: parseInt(options.quality, 10)
                        });
                        setFileMetadata(filePath, currentOutputPath);

                        totalOriginal += result.originalSize;
                        totalCompressed += result.compressedSize;
                        successCount++;

                        console.log(chalk.green(`   ✓ ${path.basename(currentOutputPath)}: ${result.originalSizeFormatted} → ${result.compressedSizeFormatted} (${result.savings} saved)`));
                        return result;
                    } catch (error) {
                        console.log(chalk.yellow(`   ⚠ ${fileName}: Compression failed (${error.message}). Copying original instead...`));
                        const currentOutputPath = await determineTargetFile(filePath);
                        fs.copyFileSync(filePath, currentOutputPath);
                        setFileMetadata(filePath, currentOutputPath);
                        const originalSize = fs.statSync(filePath).size;

                        totalOriginal += originalSize;
                        totalCompressed += originalSize;
                        successCount++;

                        return { originalSize, compressedSize: originalSize, savings: '0% (copied)' };
                    }
                },
                concurrency
            );
        }

        // Process videos in parallel (I/O and CPU heavy)
        if (videoFiles.length > 0) {
            const videoConcurrency = Math.max(1, Math.min(2, Math.floor(os.cpus().length / 4)));
            console.log(chalk.blue(`\n🎬 Processing videos in parallel (${videoConcurrency} jobs)...\n`));

            await parallelProcess(
                videoFiles,
                async (filePath) => {
                    const fileName = path.basename(filePath);
                    try {
                        const currentOutputPath = await determineTargetFile(filePath);

                        if (options.renameOnly) {
                            fs.copyFileSync(filePath, currentOutputPath);
                            setFileMetadata(filePath, currentOutputPath);
                            const size = fs.statSync(filePath).size;
                            totalOriginal += size;
                            totalCompressed += size; // No savings
                            successCount++;
                            console.log(chalk.green(`   ✓ ${path.basename(currentOutputPath)}: Copied/Renamed`));
                            return;
                        }

                        console.log(chalk.gray(`   Processing: ${fileName}...`));
                        let currentCmd = null;
                        const result = await compressVideo(filePath, currentOutputPath, {
                            crf: parseInt(options.crf, 10),
                            preset: options.preset || 'veryfast',
                            encoder: options.encoder || 'auto',
                            onStart: (cmd) => {
                                currentCmd = cmd;
                                activeProcesses.add(cmd);
                            }
                        });

                        if (currentCmd) activeProcesses.delete(currentCmd);
                        setFileMetadata(filePath, currentOutputPath);

                        totalOriginal += result.originalSize;
                        totalCompressed += result.compressedSize;
                        successCount++;

                        console.log(chalk.green(`   ✓ ${path.basename(currentOutputPath)}: ${result.originalSizeFormatted} → ${result.compressedSizeFormatted} (${result.savings} saved)`));
                    } catch (error) {
                        console.log(chalk.yellow(`   ⚠ ${fileName}: Compression failed (${error.message || error.error || 'Unknown error'}). Copying original...`));
                        const currentOutputPath = await determineTargetFile(filePath);
                        fs.copyFileSync(filePath, currentOutputPath);
                        setFileMetadata(filePath, currentOutputPath);
                        const originalSize = fs.statSync(filePath).size;

                        totalOriginal += originalSize;
                        totalCompressed += originalSize;
                        successCount++;
                    }
                },
                videoConcurrency
            );
        }

        const endTime = Date.now();
        const durationSeconds = ((endTime - startTime) / 1000).toFixed(1);

        console.log(chalk.blue('\n📊 Summary Report'));
        console.log(chalk.white(`   Files processed:  ${successCount}/${allFiles.length}`));
        if (failCount > 0) console.log(chalk.red(`   Failed:           ${failCount}`));
        console.log(chalk.white(`   Time taken:       ${durationSeconds}s`));
        console.log(chalk.white(`   Total original:   ${formatFileSize(totalOriginal)}`));
        console.log(chalk.white(`   Total compressed: ${formatFileSize(totalCompressed)}`));
        console.log(chalk.cyan(`   Total saved:      ${formatFileSize(totalOriginal - totalCompressed)} (${getCompressionRatio(totalOriginal, totalCompressed)} reduction)`));
        console.log(chalk.gray(`   Output directory: ${outputDir}`));
    } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
    }
}

// Configure CLI
program
    .name('compress')
    .description('CLI tool to compress images and videos')
    .version(packageJson.version);

// Image compression command
program
    .command('image <input>')
    .description('Compress an image file OR directory of images (supports: jpg, png, webp, avif, tiff, gif, heic)')
    .option('-o, --output <path>', 'Output file path or directory')
    .option('-q, --quality <number>', 'Quality level (1-100, default: 88)', '88')
    .option('--image-format <format>', 'Target image format: jpeg, webp, avif (default: webp)', 'webp')
    .option('--rename', 'Rename file based on capture date (yyyymmdd-hhmmss)', false)
    .option('--rename-only', 'Rename and copy files without compressing', false) // ADDED
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

            // Single File Mode
            if (!isImage(inputPath)) {
                console.error(chalk.red('Error: Input file is not a supported image format'));
                process.exit(1);
            }

            try {
                let currentOutputPath = await getFinalOutputPath(inputPath, options, generateOutputPath(inputPath, options.output));

                if (options.renameOnly) {
                    fs.copyFileSync(inputPath, currentOutputPath);
                    setFileMetadata(inputPath, currentOutputPath);
                    console.log(chalk.green('\n✅ File copied and renamed (No compression).'));
                    return;
                }

                console.log(chalk.blue('🖼️  Compressing image...'));
                console.log(chalk.gray(`   Input:  ${inputPath}`));
                console.log(chalk.gray(`   Output: ${currentOutputPath}`));

                const result = await compressImage(inputPath, currentOutputPath, { quality: parseInt(options.quality, 10) });
                setFileMetadata(inputPath, currentOutputPath);

                console.log(chalk.green('\n✅ Compression complete!'));
                console.log(chalk.white(`   Original:   ${result.originalSizeFormatted}`));
                console.log(chalk.white(`   Compressed: ${result.compressedSizeFormatted}`));
                console.log(chalk.cyan(`   Saved:      ${result.savings}`));
            } catch (error) {
                console.log(chalk.yellow(`\n⚠ Compression failed (${error.message}). Copying original instead...`));
                const finalOutputPath = await getFinalOutputPath(inputPath, options, generateOutputPath(inputPath, options.output));

                fs.copyFileSync(inputPath, finalOutputPath);
                setFileMetadata(inputPath, finalOutputPath);
                console.log(chalk.green('✅ Original file copied to output with metadata preserved.'));
            }
        } catch (error) {
            console.error(chalk.red(`Error: ${error.message}`));
            process.exit(1);
        }
    });

// Video compression command
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

            // Single File Mode
            if (!isVideo(inputPath)) {
                console.error(chalk.red('Error: Input file is not a supported video format'));
                process.exit(1);
            }

            try {
                let currentOutputPath = await getFinalOutputPath(inputPath, options, generateOutputPath(inputPath, options.output));

                if (options.renameOnly) {
                    fs.copyFileSync(inputPath, currentOutputPath);
                    setFileMetadata(inputPath, currentOutputPath);
                    console.log(chalk.green('\n✅ File copied and renamed (No compression).'));
                    return;
                }

                const crf = parseInt(options.crf, 10);

                console.log(chalk.blue('🎬 Compressing video...'));
                console.log(chalk.gray(`   Input:  ${inputPath}`));
                console.log(chalk.gray(`   Output: ${currentOutputPath}`));
                console.log(chalk.gray(`   CRF:    ${crf} | Encoder: ${options.encoder}`));

                const result = await compressVideo(inputPath, currentOutputPath, {
                    crf,
                    preset: options.preset,
                    encoder: options.encoder,
                    onStart: (cmd) => activeProcesses.add(cmd),
                    onProgress: (progress) => {
                        if (progress.percent) {
                            process.stdout.write(chalk.gray(`\r   Progress: ${progress.percent.toFixed(1)}%`));
                        }
                    }
                });

                activeProcesses.clear();
                setFileMetadata(inputPath, currentOutputPath);

                console.log(chalk.green('\n\n✅ Compression complete!'));
                console.log(chalk.white(`   Original:   ${result.originalSizeFormatted}`));
                console.log(chalk.white(`   Compressed: ${result.compressedSizeFormatted}`));
                console.log(chalk.cyan(`   Saved:      ${result.savings}`));
            } catch (error) {
                console.log(chalk.yellow(`\n\n⚠ Compression failed (${error.message || error.error}). Copying original instead...`));
                const finalOutputPath = await getFinalOutputPath(inputPath, options, generateOutputPath(inputPath, options.output));

                fs.copyFileSync(inputPath, finalOutputPath);
                setFileMetadata(inputPath, finalOutputPath);
                console.log(chalk.green('✅ Original file copied to output with metadata preserved.'));
            }
        } catch (error) {
            console.error(chalk.red(`\nError: ${error.message || error.error}`));
            process.exit(1);
        }
    });

// Batch compression command
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
    .option('-p, --preset <preset>', 'Encoding preset for CPU (ultrafast, fast, medium, slow, veryslow)', 'veryfast')
    .option('--rename', 'Rename files based on capture date (yyyymmdd-hhmmss)', false)
    .option('--rename-only', 'Rename and copy files without compressing', false)
    .action(async (inputDir, options) => {
        await processDirectory(inputDir, options, 'all');
    });

// Parse arguments
program.parse();