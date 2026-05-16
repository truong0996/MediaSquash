const { detectAvailableEncoders, getBestEncoder, getEncoderConfig, ENCODER_CONFIGS } = require('../hwEncoder');

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

console.log('\n=== Hardware Encoder Tests ===\n');

test('ENCODER_CONFIGS: has all encoder types', () => {
    assertCondition(ENCODER_CONFIGS.nvenc, 'Should have nvenc config');
    assertCondition(ENCODER_CONFIGS.amf, 'Should have amf config');
    assertCondition(ENCODER_CONFIGS.qsv, 'Should have qsv config');
    assertCondition(ENCODER_CONFIGS.x264, 'Should have x264 config');
    assertCondition(ENCODER_CONFIGS.x265, 'Should have x265 config');
});

test('ENCODER_CONFIGS: nvenc has correct codec', () => {
    assertEquals(ENCODER_CONFIGS.nvenc.codec, 'hevc_nvenc', 'NVENC codec should be hevc_nvenc');
});

test('ENCODER_CONFIGS: amf has correct codec', () => {
    assertEquals(ENCODER_CONFIGS.amf.codec, 'hevc_amf', 'AMF codec should be hevc_amf');
});

test('ENCODER_CONFIGS: qsv has correct codec', () => {
    assertEquals(ENCODER_CONFIGS.qsv.codec, 'hevc_qsv', 'QSV codec should be hevc_qsv');
});

test('ENCODER_CONFIGS: x264 has correct codec', () => {
    assertEquals(ENCODER_CONFIGS.x264.codec, 'libx264', 'x264 codec should be libx264');
});

test('ENCODER_CONFIGS: x265 has correct codec', () => {
    assertEquals(ENCODER_CONFIGS.x265.codec, 'libx265', 'x265 codec should be libx265');
});

test('ENCODER_CONFIGS: nvenc getOutputOptions returns array', () => {
    const options = ENCODER_CONFIGS.nvenc.getOutputOptions(22);
    assertCondition(Array.isArray(options), 'Should return array');
    assertCondition(options.length > 0, 'Should have options');
});

test('ENCODER_CONFIGS: x264 getOutputOptions accepts preset and threads', () => {
    const options = ENCODER_CONFIGS.x264.getOutputOptions(22, 'fast', 4);
    assertCondition(Array.isArray(options), 'Should return array');
    assertCondition(options.some(opt => opt.includes('fast')), 'Should include preset');
    assertCondition(options.some(opt => opt.includes('4')), 'Should include threads');
});

test('ENCODER_CONFIGS: x265 includes 10-bit settings', () => {
    const options = ENCODER_CONFIGS.x265.getOutputOptions(22);
    assertCondition(options.some(opt => opt.includes('main10')), 'Should include main10 profile');
    assertCondition(options.some(opt => opt.includes('yuv420p10le')), 'Should include 10-bit pixel format');
});

test('ENCODER_CONFIGS: nvenc includes 10-bit settings', () => {
    const options = ENCODER_CONFIGS.nvenc.getOutputOptions(22);
    assertCondition(options.some(opt => opt.includes('p010le')), 'Should include p010le pixel format');
    assertCondition(options.some(opt => opt.includes('main10')), 'Should include main10 profile');
});

(async () => {
    await testAsync('detectAvailableEncoders: returns object with expected keys', async () => {
        const result = await detectAvailableEncoders();
        assertCondition(typeof result === 'object', 'Should return object');
        assertCondition('nvenc' in result, 'Should have nvenc key');
        assertCondition('amf' in result, 'Should have amf key');
        assertCondition('qsv' in result, 'Should have qsv key');
        assertCondition('x264' in result, 'Should have x264 key');
        assertCondition('x265' in result, 'Should have x265 key');
    });

    await testAsync('detectAvailableEncoders: software encoders always available', async () => {
        const result = await detectAvailableEncoders();
        assertEquals(result.x264, true, 'x264 should always be available');
        assertEquals(result.x265, true, 'x265 should always be available');
    });

    await testAsync('getBestEncoder: returns valid encoder string', async () => {
        const encoder = await getBestEncoder();
        const validEncoders = ['nvenc', 'amf', 'qsv', 'x264'];
        assertCondition(validEncoders.includes(encoder), `Should return valid encoder, got: ${encoder}`);
    });

    await testAsync('getEncoderConfig: auto selects available encoder', async () => {
        const config = await getEncoderConfig('auto');
        assertCondition(config.type, 'Should have type property');
        assertCondition(config.codec, 'Should have codec property');
        assertCondition(typeof config.getOutputOptions === 'function', 'Should have getOutputOptions function');
    });

    await testAsync('getEncoderConfig: x264 returns correct config', async () => {
        const config = await getEncoderConfig('x264');
        assertEquals(config.type, 'x264', 'Type should be x264');
        assertEquals(config.codec, 'libx264', 'Codec should be libx264');
    });

    await testAsync('getEncoderConfig: x265 returns correct config', async () => {
        const config = await getEncoderConfig('x265');
        assertEquals(config.type, 'x265', 'Type should be x265');
        assertEquals(config.codec, 'libx265', 'Codec should be libx265');
    });

    await testAsync('getEncoderConfig: fallback when hardware unavailable', async () => {
        const config = await getEncoderConfig('nvenc');
        assertCondition(config.type, 'Should return a valid config even if NVENC unavailable');
        assertCondition(config.codec, 'Should have codec');
    });

    console.log('\n=== Hardware Encoder Summary ===\n');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log('');

    process.exit(failed > 0 ? 1 : 0);
})();
