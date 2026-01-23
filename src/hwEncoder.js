/**
 * Hardware Encoder Detection and Configuration Module
 * 
 * Supports:
 * - NVIDIA NVENC (hevc_nvenc) - Fastest, lowest CPU usage, 10-bit
 * - AMD AMF (hevc_amf) - For AMD GPUs and APUs, 10-bit
 * - Intel QuickSync (hevc_qsv) - Good fallback for Intel CPUs, 10-bit
 * - Software x265 (libx265) - Universal fallback, 10-bit
 */

const { exec } = require('child_process');
const path = require('path');
const { getFFmpegPath: resolveFFmpegPath } = require('./utils');

// Try to use system FFmpeg first, fallback to ffmpeg-static
let ffmpegPath = resolveFFmpegPath();

// Encoder configurations optimized for quality/speed balance
const ENCODER_CONFIGS = {
    nvenc: {
        name: 'NVIDIA NVENC (HEVC 10-bit)',
        codec: 'hevc_nvenc',
        // p4 preset is balanced, -cq is quality-based VBR (similar to CRF)
        // -pix_fmt p010le for 10-bit HEVC
        getOutputOptions: (crf) => [
            '-pix_fmt p010le',
            '-preset p4',
            '-tune hq',
            '-rc vbr',
            `-cq ${crf}`,
            '-profile:v main10',
            '-spatial-aq 1',
            '-temporal-aq 1',
            '-multipass fullres',
            '-rc-lookahead 32', 
            '-b_ref_mode each'
        ]
    },
    amf: {
        name: 'AMD AMF (HEVC 10-bit)',
        codec: 'hevc_amf',
        // quality preset, qp_i/qp_p for quality control (similar to CRF)
        // -pix_fmt p010le for 10-bit HEVC
        getOutputOptions: (crf) => [
            '-pix_fmt p010le',
            '-quality quality',
            `-qp_i ${crf}`,
            `-qp_p ${crf}`,
            '-profile:v main10',
            '-preanalysis 1',
            '-vbaq 1'   
        ]
    },
    qsv: {
        name: 'Intel QuickSync (HEVC 10-bit)',
        codec: 'hevc_qsv',
        // -pix_fmt p010le for 10-bit HEVC
        getOutputOptions: (crf) => [
            '-pix_fmt p010le',
            '-preset medium',
            `-global_quality ${crf}`,
            '-profile:v main10',
            '-look_ahead 1',
            '-look_ahead_depth 40',
            '-extbrc 1'
        ]
    },
    x264: {
        name: 'Software (x264)',
        codec: 'libx264',
        // Medium preset: good quality/speed balance for users who prioritize quality
        getOutputOptions: (crf, preset = 'medium', threads = 0) => [
            `-crf ${crf}`,
            `-preset ${preset}`,
            `-threads ${threads}`
        ]
    },
    x265: {
        name: 'Software (x265/HEVC)',
        codec: 'libx265',
        // x265 CRF scale is slightly different - same number = better quality than x264
        // So CRF 22 in x265 ≈ CRF 20 in x264 quality, but 40% smaller file
        getOutputOptions: (crf, preset = 'medium', threads = 0) => [
            `-crf ${crf}`,
            `-preset ${preset}`,
            `-threads ${threads}`,
            '-pix_fmt yuv420p10le', // 10-bit color depth
            '-profile:v main10',    // Main 10 profile for HDR/10-bit
            '-tag:v hvc1'  // Apple/QuickTime compatibility tag
        ]
    }
};

// Cache for encoder availability (avoid repeated detection)
let encoderCache = null;

/**
 * Run FFmpeg command and return stdout
 * @param {string} args - FFmpeg arguments
 * @returns {Promise<string>}
 */
function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
        exec(`"${ffmpegPath}" ${args}`, { timeout: 10000 }, (error, stdout, stderr) => {
            // FFmpeg outputs to stderr for info commands
            resolve(stderr || stdout || '');
        });
    });
}

/**
 * Check if a specific encoder is available
 * @param {string} encoderName - Encoder name (e.g., 'h264_nvenc')
 * @returns {Promise<boolean>}
 */
async function isEncoderAvailable(encoderName) {
    try {
        const output = await runFFmpeg(`-hide_banner -encoders`);
        // Check if encoder is listed and not marked as unavailable
        const regex = new RegExp(`\\s${encoderName}\\s`, 'i');
        return regex.test(output);
    } catch {
        return false;
    }
}

/**
 * Test if encoder actually works (not just listed)
 * @param {string} encoderName - Encoder name
 * @returns {Promise<boolean>}
 */
async function testEncoder(encoderName) {
    return new Promise((resolve) => {
        // Create a simple test: encode 1 frame of null video
        const testCmd = `"${ffmpegPath}" -hide_banner -f lavfi -i nullsrc=s=256x256:d=0.1 -c:v ${encoderName} -f null -`;

        exec(testCmd, { timeout: 15000 }, (error) => {
            resolve(!error);
        });
    });
}

/**
 * Detect all available hardware encoders
 * @param {boolean} forceRecheck - Force re-detection even if cached
 * @returns {Promise<Object>} - { nvenc: boolean, amf: boolean, qsv: boolean, cpu: boolean }
 */
async function detectAvailableEncoders(forceRecheck = false) {
    if (encoderCache && !forceRecheck) {
        return encoderCache;
    }

    console.log('🔍 Detecting available hardware encoders...');

    const results = {
        nvenc: false,
        amf: false,
        qsv: false,
        x264: true, // Always available (CPU-based H.264)
        x265: true // Always available (CPU-based HEVC)
    };

    // Check NVENC (NVIDIA)
    if (await isEncoderAvailable('hevc_nvenc')) {
        results.nvenc = await testEncoder('hevc_nvenc');
        if (results.nvenc) {
            console.log('  ✓ NVIDIA NVENC: Available');
        } else {
            console.log('  ✗ NVIDIA NVENC: Listed but not working (driver issue?)');
        }
    } else {
        console.log('  ✗ NVIDIA NVENC: Not available');
    }

    // Check AMF (AMD)
    if (await isEncoderAvailable('hevc_amf')) {
        results.amf = await testEncoder('hevc_amf');
        if (results.amf) {
            console.log('  ✓ AMD AMF: Available');
        } else {
            console.log('  ✗ AMD AMF: Listed but not working (driver issue?)');
        }
    } else {
        console.log('  ✗ AMD AMF: Not available');
    }

    // Check QuickSync (Intel)
    if (await isEncoderAvailable('hevc_qsv')) {
        results.qsv = await testEncoder('hevc_qsv');
        if (results.qsv) {
            console.log('  ✓ Intel QuickSync: Available');
        } else {
            console.log('  ✗ Intel QuickSync: Listed but not working');
        }
    } else {
        console.log('  ✗ Intel QuickSync: Not available');
    }

    console.log('  ✓ Software x264: Always available');
    console.log('  ✓ Software x265 (HEVC): Always available\n');

    encoderCache = results;
    return results;
}

/**
 * Get the best available encoder
 * Priority: NVENC > AMF > QSV > CPU
 * @returns {Promise<string>} - 'nvenc', 'amf', 'qsv', or 'cpu'
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
 * @param {string} encoder - 'auto', 'nvenc', 'amf', 'qsv', 'x264', or 'x265'
 * @returns {Promise<Object>} - { name, codec, getOutputOptions }
 */
async function getEncoderConfig(encoder = 'auto') {
    if (encoder === 'auto') {
        encoder = await getBestEncoder();
    }

    // Validate encoder is available
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

    // x265 is always available (CPU-based)

    return {
        type: encoder,
        ...ENCODER_CONFIGS[encoder]
    };
}

/**
 * Set custom FFmpeg path
 * @param {string} customPath - Path to FFmpeg executable
 */
function setFFmpegPath(customPath) {
    ffmpegPath = customPath;
    encoderCache = null; // Reset cache when path changes
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
