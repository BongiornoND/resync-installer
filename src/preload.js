const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getLatestRelease: () => ipcRenderer.invoke('installer:getLatestRelease'),
  chooseLocation: () => ipcRenderer.invoke('installer:chooseLocation'),
  checkDiskSpace: (targetPath) => ipcRenderer.invoke('installer:checkDiskSpace', targetPath),
  install: (installDir, createShortcut) => ipcRenderer.invoke('installer:install', { installDir, createShortcut }),
  cancelInstall: () => ipcRenderer.invoke('installer:cancelInstall'),
  launch: (exePath) => ipcRenderer.invoke('installer:launch', exePath),
  cancel: () => ipcRenderer.invoke('installer:cancel'),
  onLog: (callback) => ipcRenderer.on('installer:log', (_event, message) => callback(message)),
  onProgress: (callback) => ipcRenderer.on('installer:progress', (_event, data) => callback(data)),
});
