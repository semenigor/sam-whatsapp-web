const { contextBridge, ipcRenderer } = require('electron');

function getQueryValue(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name) || '';
}

contextBridge.exposeInMainWorld('previewApi', {
  getData: () => ({
    title: getQueryValue('title'),
    pdfUrl: getQueryValue('pdfUrl'),
    originalPath: getQueryValue('originalPath')
  }),

  openOriginal: async () => {
    const originalPath = getQueryValue('originalPath');
    return ipcRenderer.invoke('preview:open-original', originalPath);
  },

  showInFolder: async () => {
    const originalPath = getQueryValue('originalPath');
    return ipcRenderer.invoke('preview:show-in-folder', originalPath);
  },

  closeWindow: async () => {
    return ipcRenderer.invoke('preview:close-window');
  }
});
