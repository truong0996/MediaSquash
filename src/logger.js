const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'logs');
const logFile = path.join(logDir, 'mediasquash.log');

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
};

let currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

function formatMessage(level, msg) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] ${msg}`;
}

function writeLog(level, msg) {
    if (LOG_LEVELS[level] > currentLevel) return;

    const formatted = formatMessage(level, msg);

    if (level === 'error' || level === 'warn') {
        console.error(formatted);
    } else {
        console.log(formatted);
    }

    try {
        fs.appendFileSync(logFile, formatted + '\n');
    } catch {
    }
}

const logger = {
    error: (msg) => writeLog('error', msg),
    warn: (msg) => writeLog('warn', msg),
    info: (msg) => writeLog('info', msg),
    debug: (msg) => writeLog('debug', msg),
    setLevel: (level) => {
        if (LOG_LEVELS[level] !== undefined) {
            currentLevel = LOG_LEVELS[level];
        }
    },
    getLogFile: () => logFile
};

module.exports = logger;
