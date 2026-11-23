const fs = require('fs');
const path = require('path');
const { getWritableDataDir } = require('./utils');

const logDir = path.join(getWritableDataDir(), 'logs');
const logFile = path.join(logDir, 'mediasquash.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

try {
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
        const rotated = path.join(logDir, 'mediasquash.log.old');
        try { fs.unlinkSync(rotated); } catch {}
        fs.renameSync(logFile, rotated);
    }
} catch {
}

const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
};

let currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];
let writeStream = null;

function getStream() {
    if (writeStream) return writeStream;
    try {
        writeStream = fs.createWriteStream(logFile, { flags: 'a' });
        writeStream.on('error', () => {
            writeStream = null;
        });
    } catch {
        writeStream = null;
    }
    return writeStream;
}

function formatMessage(level, msg) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] ${msg}`;
}

function writeLog(level, msg, extra) {
    if (LOG_LEVELS[level] > currentLevel) return;

    const fullMsg = extra !== undefined ? `${msg} ${extra}` : msg;
    const formatted = formatMessage(level, fullMsg);

    if (level === 'error' || level === 'warn') {
        console.error(formatted);
    } else {
        console.log(formatted);
    }

    const stream = getStream();
    if (stream && !stream.destroyed) {
        stream.write(formatted + '\n');
    }
}

const logger = {
    error: (msg, extra) => writeLog('error', msg, extra),
    warn: (msg, extra) => writeLog('warn', msg, extra),
    info: (msg, extra) => writeLog('info', msg, extra),
    debug: (msg, extra) => writeLog('debug', msg, extra),
    setLevel: (level) => {
        if (LOG_LEVELS[level] !== undefined) {
            currentLevel = LOG_LEVELS[level];
        }
    },
    getLogFile: () => logFile
};

module.exports = logger;
