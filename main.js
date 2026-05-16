const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const logger = require('./src/logger');

logger.info('App starting...');

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    logger.info('Duplicate instance detected, quitting.');
    app.quit();
}

function createWindow() {
    logger.info('Creating window...');
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        icon: path.join(__dirname, 'gui', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'gui', 'preload.js')
        }
    });

    mainWindow.setMenuBarVisibility(false);

    logger.info('Loading URL...');
    mainWindow.loadURL('http://localhost:3847')
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

try {
    logger.info('Starting server...');
    const startServer = require('./server.js');
    // Start server if it exports a function (Promise)
    if (typeof startServer === 'object' && startServer instanceof Promise) {
        startServer.then(() => {
            logger.info('Server started successfully');
        }).catch(err => {
            logger.error('Server failed to start (promise rejected): ' + err.stack);
            dialog.showErrorBox('Server Error', 'Failed to start local server: ' + err.message);
        });
    } else {
        logger.warn('Server module required but returned: ' + typeof startServer);
    }
} catch (e) {
    logger.error('CRITICAL ERROR requiring server.js: ' + e.stack);
    dialog.showErrorBox('Startup Error', 'Critical error starting server: ' + e.message);
}

async function handleOpenDialog() {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory']
    });
    if (canceled) {
        return;
    } else {
        return filePaths[0];
    }
}

app.whenReady().then(() => {
    logger.info('App ready');
    ipcMain.handle('dialog:openDirectory', handleOpenDialog);
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
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
