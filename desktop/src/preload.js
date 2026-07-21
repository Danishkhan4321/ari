const { contextBridge, ipcRenderer } = require('electron');

const sessionDebugEnabled = process.argv.includes('--ari-session-debug');
const meetingProgressChannel = 'desktop:meetings:progress';

contextBridge.exposeInMainWorld('ariDesktop', Object.freeze({
  retry: () => ipcRenderer.send('desktop:retry'),
  quit: () => ipcRenderer.send('desktop:quit'),
  auth: Object.freeze({
    startGoogle: () => ipcRenderer.invoke('desktop:auth:google'),
  }),
  ai: Object.freeze({
    getStatus: () => ipcRenderer.invoke('desktop:ai:status'),
    connectCodex: () => ipcRenderer.invoke('desktop:ai:connect'),
    disconnectCodex: () => ipcRenderer.invoke('desktop:ai:disconnect'),
    setPreference: (preference) => ipcRenderer.invoke('desktop:ai:preference', preference),
  }),
  dictation: Object.freeze({
    getStatus: () => ipcRenderer.invoke('desktop:dictation:status'),
    start: () => ipcRenderer.invoke('desktop:dictation:start'),
    stop: () => ipcRenderer.invoke('desktop:dictation:stop'),
    setEnabled: (enabled) => ipcRenderer.invoke('desktop:dictation:set-enabled', enabled),
    pasteLast: () => ipcRenderer.invoke('desktop:dictation:paste-last'),
    testMicrophone: () => ipcRenderer.invoke('desktop:dictation:test-microphone'),
    listRecent: () => ipcRenderer.invoke('desktop:dictation:recent'),
    copyRecent: (transcriptId) => ipcRenderer.invoke('desktop:dictation:copy-transcript', transcriptId),
  }),
  meetings: Object.freeze({
    capabilities: () => ipcRenderer.invoke('desktop:meetings:capabilities'),
    prepare: (metadata) => ipcRenderer.invoke('desktop:meetings:prepare', metadata),
    start: (sessionId) => ipcRenderer.invoke('desktop:meetings:start', sessionId),
    writeChunk: (sessionId, chunk) => ipcRenderer.invoke('desktop:meetings:writeChunk', sessionId, chunk),
    pause: (sessionId) => ipcRenderer.invoke('desktop:meetings:pause', sessionId),
    resume: (sessionId) => ipcRenderer.invoke('desktop:meetings:resume', sessionId),
    stop: (sessionId) => ipcRenderer.invoke('desktop:meetings:stop', sessionId),
    cancel: (sessionId) => ipcRenderer.invoke('desktop:meetings:cancel', sessionId),
    onProgress: (listener) => {
      if (typeof listener !== 'function') return () => {};
      const wrapped = (_event, progress) => listener(progress);
      ipcRenderer.on(meetingProgressChannel, wrapped);
      return () => ipcRenderer.removeListener(meetingProgressChannel, wrapped);
    },
  }),
  ...(sessionDebugEnabled ? {
    debug: Object.freeze({
      showSessionContextMenu: (sessionId) => ipcRenderer.invoke('desktop:debug:session-menu', sessionId),
    }),
  } : {}),
}));
