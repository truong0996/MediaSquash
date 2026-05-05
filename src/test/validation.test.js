const path = require('path');
const fs = require('fs');
const { validateQuality, validateCrf, validateImageFormat, validateEncoder, clearCaptureDateCache, getCaptureDateCached, setCaptureDateCached, getAvailableMemory, getRecommendedVideoConcurrency, isLowMemory, isAlreadyProcessed } = require('../utils');
const { getAdaptiveCrf } = require('../videoCompressor');

let passed = 0;
let failed = 0;

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

function assertEquals(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg || 'Assertion failed'}: expected ${expected}, got ${actual}`);
    }
}

console.log('\n=== Validation Tests ===\n');

test('validateQuality: clamps valid value', () => {
    assertEquals(validateQuality(50), 50);
});

test('validateQuality: clamps out of range high', () => {
    assertEquals(validateQuality(150), 100);
});

test('validateQuality: clamps out of range low', () => {
    assertEquals(validateQuality(-10), 1);
});

test('validateQuality: handles NaN', () => {
    assertEquals(validateQuality('abc'), 88);
});

test('validateCrf: clamps valid value', () => {
    assertEquals(validateCrf(22), 22);
});

test('validateCrf: clamps out of range high', () => {
    assertEquals(validateCrf(100), 51);
});

test('validateCrf: clamps out of range low', () => {
    assertEquals(validateCrf(-5), 0);
});

test('validateCrf: handles NaN', () => {
    assertEquals(validateCrf('xyz'), 22);
});

test('validateImageFormat: accepts webp', () => {
    assertEquals(validateImageFormat('webp'), 'webp');
});

test('validateImageFormat: accepts jpeg', () => {
    assertEquals(validateImageFormat('jpeg'), 'jpeg');
});

test('validateImageFormat: normalizes jpg', () => {
    assertEquals(validateImageFormat('jpg'), 'jpeg');
});

test('validateImageFormat: accepts avif', () => {
    assertEquals(validateImageFormat('avif'), 'avif');
});

test('validateImageFormat: rejects invalid, defaults to webp', () => {
    assertEquals(validateImageFormat('invalid'), 'webp');
});

test('validateImageFormat: handles case insensitivity', () => {
    assertEquals(validateImageFormat('WEBP'), 'webp');
});

test('validateEncoder: accepts nvenc', () => {
    assertEquals(validateEncoder('nvenc'), 'nvenc');
});

test('validateEncoder: accepts x264', () => {
    assertEquals(validateEncoder('x264'), 'x264');
});

test('validateEncoder: accepts x265', () => {
    assertEquals(validateEncoder('x265'), 'x265');
});

test('validateEncoder: accepts auto', () => {
    assertEquals(validateEncoder('auto'), 'auto');
});

test('validateEncoder: rejects invalid, defaults to auto', () => {
    assertEquals(validateEncoder('invalid'), 'auto');
});

test('validateEncoder: handles case insensitivity', () => {
    assertEquals(validateEncoder('NVENC'), 'nvenc');
});

console.log('\n=== Cache Tests ===\n');

test('captureDateCache: stores and retrieves', () => {
    clearCaptureDateCache();
    const date = new Date('2024-01-15');
    setCaptureDateCached('/test/file.jpg', date);
    assertEquals(getCaptureDateCached('/test/file.jpg'), date);
});

test('captureDateCache: returns null for missing', () => {
    clearCaptureDateCache();
    assertEquals(getCaptureDateCached('/nonexistent'), null);
});

test('captureDateCache: clears all', () => {
    clearCaptureDateCache();
    setCaptureDateCached('/test/file.jpg', new Date());
    clearCaptureDateCache();
    assertEquals(getCaptureDateCached('/test/file.jpg'), null);
});

console.log('\n=== Memory & Performance Tests ===\n');

test('getAvailableMemory: returns positive number', () => {
    const mem = getAvailableMemory();
    if (mem <= 0) throw new Error('Memory should be positive');
});

test('getRecommendedVideoConcurrency: returns valid range', () => {
    const concurrency = getRecommendedVideoConcurrency(10);
    if (concurrency < 1 || concurrency > 10) throw new Error('Should be between 1 and 10');
});

test('isLowMemory: returns boolean', () => {
    const result = isLowMemory();
    if (typeof result !== 'boolean') throw new Error('Should return boolean');
});

console.log('\n=== Adaptive CRF Tests ===\n');

test('getAdaptiveCrf: 4K video adds 2', () => {
    const info = { streams: [{ codec_type: 'video', width: 3840, height: 2160, duration: 300 }] };
    assertEquals(getAdaptiveCrf(22, info), 24);
});

test('getAdaptiveCrf: 1080p keeps same', () => {
    const info = { streams: [{ codec_type: 'video', width: 1920, height: 1080, duration: 300 }] };
    assertEquals(getAdaptiveCrf(22, info), 22);
});

test('getAdaptiveCrf: 720p subtracts 1', () => {
    const info = { streams: [{ codec_type: 'video', width: 1280, height: 720, duration: 300 }] };
    assertEquals(getAdaptiveCrf(22, info), 21);
});

test('getAdaptiveCrf: 480p subtracts 2', () => {
    const info = { streams: [{ codec_type: 'video', width: 640, height: 480, duration: 300 }] };
    assertEquals(getAdaptiveCrf(22, info), 20);
});

test('getAdaptiveCrf: long video adds 1', () => {
    const info = { streams: [{ codec_type: 'video', width: 1920, height: 1080, duration: 900 }] };
    assertEquals(getAdaptiveCrf(22, info), 23);
});

test('getAdaptiveCrf: clamps to max 51', () => {
    const info = { streams: [{ codec_type: 'video', width: 3840, height: 2160, duration: 900 }] };
    assertEquals(getAdaptiveCrf(50, info), 51);
});

console.log('\n=== Summary ===\n');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('');

process.exit(failed > 0 ? 1 : 0);