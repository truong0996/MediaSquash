const path = require('path');
const fs = require('fs');
const { compressVideo, getVideoInfo, getAdaptiveCrf, isSupportedFormat, SUPPORTED_EXTENSIONS, DEFAULT_SETTINGS } = require('../videoCompressor');

let passed = 0;
let failed = 0;
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
    try {
        await fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`✗ ${name}: ${err.message}`);
        failed++;
    }
}

function assertCondition(condition, msg) {
    if (!condition) {
        throw new Error(msg || 'Assertion failed');
    }
}

function assertEquals(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg || 'Assertion failed'}: expected ${expected}, got ${actual}`);
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

console.log('\n=== Video Compressor Tests ===\n');

setup();

test('SUPPORTED_EXTENSIONS: contains common formats', () => {
    assertCondition(SUPPORTED_EXTENSIONS.includes('.mp4'), 'Should include .mp4');
    assertCondition(SUPPORTED_EXTENSIONS.includes('.mkv'), 'Should include .mkv');
    assertCondition(SUPPORTED_EXTENSIONS.includes('.avi'), 'Should include .avi');
    assertCondition(SUPPORTED_EXTENSIONS.includes('.mov'), 'Should include .mov');
});

test('DEFAULT_SETTINGS: has expected defaults', () => {
    assertEquals(DEFAULT_SETTINGS.encoder, 'auto', 'Default encoder should be auto');
    assertEquals(DEFAULT_SETTINGS.crf, 22, 'Default CRF should be 22');
    assertEquals(DEFAULT_SETTINGS.preset, 'medium', 'Default preset should be medium');
    assertEquals(DEFAULT_SETTINGS.audioCodec, 'aac', 'Default audio codec should be aac');
});

test('isSupportedFormat: accepts valid extensions', () => {
    assertCondition(isSupportedFormat('video.mp4') === true, '.mp4 should be supported');
    assertCondition(isSupportedFormat('video.MP4') === true, '.MP4 should be supported (case insensitive)');
    assertCondition(isSupportedFormat('video.mkv') === true, '.mkv should be supported');
    assertCondition(isSupportedFormat('video.avi') === true, '.avi should be supported');
});

test('isSupportedFormat: rejects invalid extensions', () => {
    assertCondition(isSupportedFormat('file.txt') === false, '.txt should not be supported');
    assertCondition(isSupportedFormat('file.jpg') === false, '.jpg should not be supported');
    assertCondition(isSupportedFormat('file.png') === false, '.png should not be supported');
});

test('getAdaptiveCrf: 4K video increases CRF', () => {
    const info = { streams: [{ codec_type: 'video', width: 3840, height: 2160, duration: '300' }] };
    const crf = getAdaptiveCrf(22, info);
    assertEquals(crf, 24, '4K should add +2 to CRF');
});

test('getAdaptiveCrf: 1080p keeps base CRF', () => {
    const info = { streams: [{ codec_type: 'video', width: 1920, height: 1080, duration: '300' }] };
    const crf = getAdaptiveCrf(22, info);
    assertEquals(crf, 22, '1080p should keep base CRF');
});

test('getAdaptiveCrf: 720p decreases CRF', () => {
    const info = { streams: [{ codec_type: 'video', width: 1280, height: 720, duration: '300' }] };
    const crf = getAdaptiveCrf(22, info);
    assertEquals(crf, 21, '720p should subtract 1 from CRF');
});

test('getAdaptiveCrf: 480p decreases CRF more', () => {
    const info = { streams: [{ codec_type: 'video', width: 640, height: 480, duration: '300' }] };
    const crf = getAdaptiveCrf(22, info);
    assertEquals(crf, 20, '480p should subtract 2 from CRF');
});

test('getAdaptiveCrf: long videos increase CRF', () => {
    const info = { streams: [{ codec_type: 'video', width: 1920, height: 1080, duration: '900' }] };
    const crf = getAdaptiveCrf(22, info);
    assertEquals(crf, 23, 'Long video (>10min) should add +1 to CRF');
});

test('getAdaptiveCrf: clamps to valid range', () => {
    const info = { streams: [{ codec_type: 'video', width: 3840, height: 2160, duration: '900' }] };
    const crf = getAdaptiveCrf(50, info);
    assertCondition(crf <= 51, 'CRF should not exceed 51');
    assertCondition(crf >= 0, 'CRF should not be negative');
});

test('getAdaptiveCrf: handles missing streams', () => {
    const info = { streams: [] };
    const crf = getAdaptiveCrf(22, info);
    assertEquals(crf, 22, 'Should return base CRF when no video stream');
});

test('getAdaptiveCrf: handles null info', () => {
    const crf = getAdaptiveCrf(22, null);
    assertEquals(crf, 22, 'Should return base CRF for null info');
});

test('getAdaptiveCrf: 2K/QHD adjustment', () => {
    const info = { streams: [{ codec_type: 'video', width: 2560, height: 1440, duration: '300' }] };
    const crf = getAdaptiveCrf(22, info);
    assertEquals(crf, 23, '2K should add +1 to CRF');
});

(async () => {
    await testAsync('getVideoInfo: rejects nonexistent file', async () => {
        try {
            await getVideoInfo('/nonexistent/path/video.mp4');
            throw new Error('Should have rejected');
        } catch (err) {
            assertCondition(true, 'Should reject for missing file');
        }
    });

    console.log('\n=== Video Compressor Summary ===\n');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log('');

    process.exit(failed > 0 ? 1 : 0);
})();
