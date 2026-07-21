'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ariDictation', Object.freeze({
  session: () => ipcRenderer.invoke('dictation:overlay:session'),
  polish: (input) => ipcRenderer.invoke('dictation:overlay:polish', input),
  retry: (audio, mimeType) => ipcRenderer.invoke('dictation:overlay:retry', audio, mimeType),
  complete: (input) => ipcRenderer.invoke('dictation:overlay:complete', input),
  setState: (state) => ipcRenderer.invoke('dictation:overlay:state', state),
  dismiss: (input) => ipcRenderer.invoke('dictation:overlay:dismiss', input),
  copyLast: (rawText) => ipcRenderer.invoke('dictation:overlay:copy-last', rawText),
  onCommand: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, command) => listener(command);
    ipcRenderer.on('dictation:command', wrapped);
    return () => ipcRenderer.removeListener('dictation:command', wrapped);
  },
}));
