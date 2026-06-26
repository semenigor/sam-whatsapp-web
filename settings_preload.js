const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  load: async () => ipcRenderer.invoke('settings:load'),
  save: async (settings) => ipcRenderer.invoke('settings:save', settings),
  clearCaches: async () => ipcRenderer.invoke('settings:clear-caches'),
  openAttachmentCache: async () => ipcRenderer.invoke('settings:open-attachment-cache'),
  openPreviewCache: async () => ipcRenderer.invoke('settings:open-preview-cache')
});
