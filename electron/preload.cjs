const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('native', {
  initialFiles: invoke('initial-files'),
  openDialog: invoke('open-dialog'),
  readFile: invoke('read-file'),
  writeFile: invoke('write-file'),
  saveDialog: invoke('save-dialog'),
  chooseDir: invoke('choose-dir'),
  readSystemFont: invoke('read-system-font'),
  userName: invoke('user-name'),
  tools: invoke('tools'),
  qpdf: invoke('qpdf'),
  ghostscript: invoke('ghostscript'),
  ocr: invoke('ocr'),
  ocrLangs: invoke('ocr-langs'),
  signPdf: invoke('sign-pdf'),
  verifySignatures: invoke('verify-signatures'),
  createDigitalId: invoke('create-digital-id'),
  pickDigitalId: invoke('pick-digital-id'),
  setTitle: (t) => ipcRenderer.send('set-title', t),
  setDirty: (d) => ipcRenderer.send('set-dirty', d),
  setTheme: (t) => ipcRenderer.send('set-theme', t),
  forceClose: () => ipcRenderer.send('force-close'),
  newWindow: (files) => ipcRenderer.send('new-window', files),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onCommand: (cb) => ipcRenderer.on('command', (_e, cmd, arg) => cb(cmd, arg)),
});
