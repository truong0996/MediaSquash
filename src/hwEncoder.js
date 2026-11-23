/**
 * Hardware Encoder Detection and Configuration Module
 *
 * Supports:
 * - NVIDIA NVENC (hevc_nvenc) - Fastest, lowest CPU usage, 10-bit
 * - AMD AMF (hevc_amf) - For AMD GPUs and APUs, 10-bit
 * - Intel QuickSync (hevc_qsv) - Good fallback for Intel CPUs, 10-bit
 * - Software x264 (libx264) & x265 (libx265) - Universal fallbacks
 */

const { execFile } = require('child_process');
const { getFFmpegPath: resolveFFmpegPath } = require('./utils');

let ffmpegPath = resolveFFmpegPath();

const ENCODER_CONFIGS = {
    nvenc: {
        name: 'NVIDIA NVENC (HEVC 10-bit)',
        codec: 'hevc_nvenc',
        getOutputOptions: (crf) => [
            '-pix_fmt p010le',
            '-preset p4',
            '-rc vbr',
            '-b:v 0',
            `-cq ${crf}`,
            '-profile:v main10',
            '-tag:v hvc1'
        ]
    },
    amf: {
        name: 'AMD AMF (HEVC 10-bit)',
        codec: 'hevc_amf',
        getOutputOptions: (crf) => [
            '-pix_fmt p010le',
            '-quality quality',
            `-qp_i ${crf}`,
            `-qp_p ${crf}`,
            '-profile:v main10',
            '-preanalysis 1',
            '-vbaq 1',
            '-tag:v hvc1'
        ]
    },
    qsv: {
        name: 'Intel QuickSync (HEVC 10-bit)',
        codec: 'hevc_qsv',
        getOutputOptions: (crf) => [
            '-pix_fmt p010le',
            '-preset medium',
            `-global_quality ${crf}`,
            '-profile:v main10',
            '-look_ahead 1',
            '-look_ahead_depth 40',
            '-extbrc 1',
            '-tag:v hvc1'
        ]
    },
    x264: {
        name: 'Software (x264)',
        codec: 'libx264',
        getOutputOptions: (crf, preset = 'medium', threads = 0) => [
            `-crf ${crf}`,
            `-preset ${preset}`,
            `-threads ${threads}`
        ]
    },
    x265: {
        name: 'Software (x265/HEVC)',
        codec: 'libx265',
        getOutputOptions: (crf, preset = 'medium', threads = 0) => [
            `-crf ${crf}`,
            `-preset ${preset}`,
            `-threads ${threads}`,
            '-pix_fmt yuv420p10le',
            '-profile:v main10',
            '-tag:v hvc1'
        ]
    }
};

let encoderCache = null;
let encoderDetectionInFlight = null;

/**
 * Run FFmpeg with execFile (avoids shell overhead) and return combined output.
 * @param {string[]} args
 * @param {number} [timeout=8000]
 * @returns {Promise<{ error: Error|null, output: string }>}
 */
function runFFmpegArgs(args, timeout = 8000) {
    return new Promise((resolve) => {
        execFile(ffmpegPath, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
            resolve({ error, output: `${stderr || ''}\n${stdout || ''}` });
        });
    });
}

/**
 * Test if a hardware encoder actually works for 10-bit main10 encoding.
 * @param {string} encoderName
 * @returns {Promise<boolean>}
 */
async function testEncoder(encoderName) {
    const { error } = await runFFmpegArgs([
        '-hide_banner',
        '-f', 'lavfi',
        '-i', 'nullsrc=s=256x256:d=0.1',
        '-frames:v', '1',
        '-pix_fmt', 'p010le',
        '-c:v', encoderName,
        '-profile:v', 'main10',
        '-f', 'null',
        '-'
    ], 6000);
    return !error;
}

/**
 * Detect all available hardware encoders (single -encoders list + parallel probes).
 * @param {boolean} [forceRecheck=false]
 * @returns {Promise<Object>}
 */
async function detectAvailableEncoders(forceRecheck = false) {
    if (encoderCache && !forceRecheck) {
        return encoderCache;
    }
    if (encoderDetectionInFlight && !forceRecheck) {
        return encoderDetectionInFlight;
    }

    encoderDetectionInFlight = runEncoderDetection().finally(() => {
        encoderDetectionInFlight = null;
    });
    return encoderDetectionInFlight;
}

async function runEncoderDetection() {
    console.log('🔍 Detecting available hardware encoders...');

    const results = {
        nvenc: false,
        amf: false,
        qsv: false,
        x264: true,
        x265: true
    };

    const { output: encoderList } = await runFFmpegArgs(['-hide_banner', '-encoders'], 8000);
    const hasEncoder = (name) => new RegExp(`\\s${name}\\s`, 'i').test(encoderList);

    const probes = [
        { key: 'nvenc', codec: 'hevc_nvenc', label: 'NVIDIA NVENC' },
        { key: 'amf', codec: 'hevc_amf', label: 'AMD AMF' },
        { key: 'qsv', codec: 'hevc_qsv', label: 'Intel QuickSync' }
    ];

    await Promise.all(probes.map(async ({ key, codec, label }) => {
        if (!hasEncoder(codec)) {
            console.log(`  ✗ ${label}: Not available`);
            return;
        }
        const works = await testEncoder(codec);
        results[key] = works;
        if (works) {
            console.log(`  ✓ ${label}: Available`);
        } else {
            console.log(`  ✗ ${label}: Listed but not working (driver issue?)`);
        }
    }));

    console.log('  ✓ Software x264: Always available');
    console.log('  ✓ Software x265 (HEVC): Always available\n');

    encoderCache = results;
    return results;
}

/**
 * Get the best available encoder
 * Priority: NVENC > AMF > QSV > x264
 * @returns {Promise<string>}
 */
async function getBestEncoder() {
    const available = await detectAvailableEncoders();

    if (available.nvenc) return 'nvenc';
    if (available.amf) return 'amf';
    if (available.qsv) return 'qsv';
    return 'x264';
}

/**
 * Get encoder configuration
 * @param {string} [encoder='auto']
 * @returns {Promise<Object>}
 */
async function getEncoderConfig(encoder = 'auto') {
    if (encoder === 'auto') {
        encoder = await getBestEncoder();
    }

    const available = await detectAvailableEncoders();

    if (encoder === 'nvenc' && !available.nvenc) {
        console.log('⚠️ NVENC not available, falling back...');
        encoder = available.amf ? 'amf' : (available.qsv ? 'qsv' : 'x264');
    }

    if (encoder === 'amf' && !available.amf) {
        console.log('⚠️ AMD AMF not available, falling back...');
        encoder = available.qsv ? 'qsv' : 'x264';
    }

    if (encoder === 'qsv' && !available.qsv) {
        console.log('⚠️ QuickSync not available, falling back to x264...');
        encoder = 'x264';
    }

    return {
        type: encoder,
        ...ENCODER_CONFIGS[encoder]
    };
}

/**
 * Set custom FFmpeg path
 * @param {string} customPath
 */
function setFFmpegPath(customPath) {
    ffmpegPath = customPath;
    encoderCache = null;
    encoderDetectionInFlight = null;
}

/**
 * Get current FFmpeg path
 * @returns {string}
 */
function getFFmpegPath() {
    return ffmpegPath;
}

module.exports = {
    detectAvailableEncoders,
    getBestEncoder,
    getEncoderConfig,
    setFFmpegPath,
    getFFmpegPath,
    ENCODER_CONFIGS
};
