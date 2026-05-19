const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
    getPathForFile: (file) => webUtils?.getPathForFile?.(file) || file.path || ''
});
