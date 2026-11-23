const os = require('os');
if (!process.env.UV_THREADPOOL_SIZE) {
    const cpuCount = os.cpus().length || 4;
    process.env.UV_THREADPOOL_SIZE = String(Math.min(Math.max(cpuCount, 8), 16));
}

const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const logger = require('./src/logger');

logger.info('App starting...');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    logger.info('Duplicate instance detected, quitting.');
    app.quit();
}

function createWindow(port) {
    logger.info('Creating window...');
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 640,
        backgroundColor: '#0E0F11',
        icon: path.join(__dirname, 'gui', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'gui', 'preload.js')
        }
    });

    mainWindow.setMenuBarVisibility(false);

    const url = `http://localhost:${port}`;
    logger.info('Loading URL: ' + url);
    mainWindow.loadURL(url)
        .then(() => logger.info('URL loaded successfully'))
        .catch(err => logger.error('Failed to load URL: ' + err.message));

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http:') || url.startsWith('https:')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });
}

process.env.ELECTRON_APP = 'true';

let serverReady;
let serverPort = process.env.PORT || 3847;
let cleanupServerProcesses = null;

try {
    logger.info('Starting server...');
    const serverPromise = require('./server.js');
    if (typeof serverPromise === 'object' && serverPromise instanceof Promise) {
        serverReady = serverPromise.then((serverInfo) => {
            serverPort = serverInfo?.port || serverPort;
            cleanupServerProcesses = serverInfo?.cleanupActiveProcesses || null;
            logger.info('Server started successfully');
        }).catch(err => {
            logger.error('Server failed to start (promise rejected): ' + err.stack);
            dialog.showErrorBox('Server Error', 'Failed to start local server: ' + err.message);
        });
    } else {
        serverReady = Promise.reject(new Error('Server module returned unexpected type: ' + typeof serverPromise));
        logger.warn('Server module required but returned: ' + typeof serverPromise);
    }
} catch (e) {
    logger.error('CRITICAL ERROR requiring server.js: ' + e.stack);
    serverReady = Promise.reject(e);
    dialog.showErrorBox('Startup Error', 'Critical error starting server: ' + e.message);
}

async function handleOpenDialog() {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory']
    });
    if (canceled) {
        return;
    }
    return filePaths[0];
}

app.whenReady().then(async () => {
    logger.info('App ready');
    await serverReady;
    ipcMain.handle('dialog:openDirectory', handleOpenDialog);
    createWindow(serverPort);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow(serverPort);
        }
    });
});

app.on('before-quit', () => {
    if (typeof cleanupServerProcesses === 'function') {
        cleanupServerProcesses();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

process.on('uncaughtException', (error) => {
    logger.error('UNCAUGHT EXCEPTION: ' + error.stack);
    dialog.showErrorBox('Uncaught Exception', error.message);
});
