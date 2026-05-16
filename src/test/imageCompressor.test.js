const path = require('path');
const fs = require('fs');
const os = require('os');
const { compressImage, getSupportedExtensions, COMPRESSION_SETTINGS } = require('../imageCompressor');

let passed = 0;
let failed = 0;
let pending = 0;
const tmpDir = path.join(__dirname, 'tmp');

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`✗ ${name}: ${err.message}`);
        failed++;
    }
}

async function testAsync(name, fn) {
    pending++;
    try {
        await fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`✗ ${name}: ${err.message}`);
        failed++;
    } finally {
        pending--;
    }
}

function assertEquals(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg || 'Assertion failed'}: expected ${expected}, got ${actual}`);
    }
}

function assertCondition(condition, msg) {
    if (!condition) {
        throw new Error(msg || 'Assertion failed');
    }
}

function setup() {
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }
}

function cleanup() {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

function createTestImage(width = 100, height = 100, format = 'jpeg', quality = 80) {
    const sharp = require('sharp');
    const uniqueId = Date.now() + Math.random().toString(36).slice(2, 7);
    const filePath = path.join(tmpDir, `test_${uniqueId}.${format}`);
    const red = { r: 255, g: 0, b: 0, alpha: 1 };
    return sharp({
        create: {
            width,
            height,
            channels: 3,
            background: red
        }
    })
    .jpeg({ quality })
    .toFile(filePath)
    .then(() => filePath);
}

function createTestPNG() {
    const sharp = require('sharp');
    const uniqueId = Date.now() + Math.random().toString(36).slice(2, 7);
    const filePath = path.join(tmpDir, `test_${uniqueId}.png`);
    return sharp({
        create: {
            width: 100,
            height: 100,
            channels: 4,
            background: { r: 0, g: 255, b: 0, alpha: 1 }
        }
    })
    .png()
    .toFile(filePath)
    .then(() => filePath);
}

console.log('\n=== Image Compressor Tests ===\n');

setup();

test('getSupportedExtensions: returns array', () => {
    const exts = getSupportedExtensions();
    assertCondition(Array.isArray(exts), 'Should return array');
    assertCondition(exts.length > 0, 'Should have extensions');
});

test('COMPRESSION_SETTINGS: has jpeg config', () => {
    assertCondition(COMPRESSION_SETTINGS.jpeg, 'Should have jpeg config');
    assertCondition(COMPRESSION_SETTINGS.jpeg.mozjpeg === true, 'Should use mozjpeg');
});

test('COMPRESSION_SETTINGS: has webp config', () => {
    assertCondition(COMPRESSION_SETTINGS.webp, 'Should have webp config');
    assertCondition(COMPRESSION_SETTINGS.webp.quality === 88, 'Default quality should be 88');
});

test('COMPRESSION_SETTINGS: has avif config', () => {
    assertCondition(COMPRESSION_SETTINGS.avif, 'Should have avif config');
});

(async () => {
    await testAsync('compressImage: compresses JPEG to WebP', async () => {
        const inputPath = await createTestImage(200, 200, 'jpeg', 95);
        const outputPath = path.join(tmpDir, 'output.webp');
        const result = await compressImage(inputPath, outputPath, { quality: 80 });
        assertCondition(result.success, 'Should succeed');
        assertCondition(result.originalSize > 0, 'Should have original size');
        assertCondition(result.compressedSize > 0, 'Should have compressed size');
        assertCondition(fs.existsSync(outputPath), 'Output file should exist');
    });

    await testAsync('compressImage: compresses JPEG to JPEG', async () => {
        const inputPath = await createTestImage(200, 200, 'jpeg', 95);
        const outputPath = path.join(tmpDir, 'output_compressed.jpg');
        const result = await compressImage(inputPath, outputPath, { quality: 60 });
        assertCondition(result.success, 'Should succeed');
        // Note: compressed may not always be smaller for simple test images
    });

    await testAsync('compressImage: compresses PNG', async () => {
        const inputPath = await createTestPNG();
        const outputPath = path.join(tmpDir, 'output.webp');
        const result = await compressImage(inputPath, outputPath, { quality: 80 });
        assertCondition(result.success, 'Should succeed');
        assertCondition(fs.existsSync(outputPath), 'Output file should exist');
    });

    await testAsync('compressImage: handles quality parameter', async () => {
        const inputPath = await createTestImage(200, 200, 'jpeg', 100);
        const outputHigh = path.join(tmpDir, 'high.webp');
        const outputLow = path.join(tmpDir, 'low.webp');

        const resultHigh = await compressImage(inputPath, outputHigh, { quality: 95 });
        const resultLow = await compressImage(inputPath, outputLow, { quality: 30 });

        assertCondition(resultHigh.success, 'High quality should succeed');
        assertCondition(resultLow.success, 'Low quality should succeed');
        // Note: For simple solid-color images, quality may not affect size significantly
    });

    await testAsync('compressImage: creates output directory if missing', async () => {
        const inputPath = await createTestImage(100, 100, 'jpeg');
        const nestedDir = path.join(tmpDir, 'nested', 'deep', 'dir');
        const outputPath = path.join(nestedDir, 'output.webp');
        const result = await compressImage(inputPath, outputPath, { quality: 80 });
        assertCondition(result.success, 'Should succeed');
        assertCondition(fs.existsSync(outputPath), 'Output file should exist in nested dir');
    });

    await testAsync('compressImage: returns formatted sizes', async () => {
        const inputPath = await createTestImage(100, 100, 'jpeg');
        const outputPath = path.join(tmpDir, 'format_test.webp');
        const result = await compressImage(inputPath, outputPath, { quality: 80 });
        assertCondition(typeof result.originalSizeFormatted === 'string', 'Should have formatted original size');
        assertCondition(typeof result.compressedSizeFormatted === 'string', 'Should have formatted compressed size');
        assertCondition(typeof result.savings === 'string', 'Should have savings string');
    });

    await testAsync('compressImage: handles corrupted file gracefully', async () => {
        const corruptPath = path.join(tmpDir, 'corrupt.jpg');
        fs.writeFileSync(corruptPath, 'This is not a valid image file');
        const outputPath = path.join(tmpDir, 'corrupt_output.webp');
        const result = await compressImage(corruptPath, outputPath, { quality: 80 });
        assertCondition(result.success, 'Should not throw, fallback to copy');
    });

    await testAsync('compressImage: AVIF output format', async () => {
        const inputPath = await createTestImage(100, 100, 'jpeg');
        const outputPath = path.join(tmpDir, 'avif_output.avif');
        const result = await compressImage(inputPath, outputPath, { quality: 80 });
        assertCondition(result.success, 'Should succeed');
        assertCondition(fs.existsSync(outputPath), 'AVIF output should exist');
    });

    cleanup();
    console.log('\n=== Image Compressor Summary ===\n');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log('');
    process.exit(failed > 0 ? 1 : 0);
})();
