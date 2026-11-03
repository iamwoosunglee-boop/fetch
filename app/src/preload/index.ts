import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { LibraryConnection } from '../platform/types';
import type { ElectronBridge, IndexingProgress } from '../platform/library';

/** Electron prefixes rejected calls with English; the screens show only the main process's message. */
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args).catch((error: Error) => {
  throw new Error(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
});

contextBridge.exposeInMainWorld('fetchApp', {
  kind: 'electron',
  pathForFile: (file) => webUtils.getPathForFile(file),
  nativeAudio: {
    log: (entry) => ipcRenderer.send('search:log', entry),
    sounds: () => invoke('audio:sounds'),
    read: (id) => invoke('audio:read', id),
    plan: (request) => invoke('audio:plan', request),
    phrase: (facts) => invoke('audio:phrase', facts),
    copyReady: (id) => invoke('audio:copy-ready', id),
    saveCopy: (id, bytes) => invoke('audio:save-copy', id, bytes),
    drag: (id, icon) => invoke('audio:drag', id, icon),
    reveal: (id) => invoke('audio:reveal', id),
    idForPath: (path) => invoke('audio:id-for-path', path),
    idForHash: (hash) => invoke('audio:id-for-hash', hash),
  },
  packs: {
    load: () => invoke('packs:load'),
    revealLicense: (id) => invoke('packs:reveal-license', id),
  },
  classify: {
    overview: () => invoke('classify:overview'),
    decide: (hashes, decision) => invoke('classify:decide', hashes, decision),
    exportCsv: () => invoke('classify:export'),
  },
  collections: {
    load: () => invoke('collections:load'),
    save: (data) => invoke('collections:save', data),
  },
  connections: {
    getFolders: () => invoke('connections:folders'),
    chooseFolder: () => invoke('library:choose-folder'),
    connectFolder: (root) => invoke('library:connect', root),
    connectPath: (path) => invoke('library:connect-drop', path),
    rescanFolder: (root) => invoke('library:rescan', root),
    removeFolder: (root) => invoke('connections:remove', root),
    tracking: {
      load: () => invoke('connections:tracking'),
      answer: (path, inherit) => invoke('connections:answer-change', path, inherit),
    },
    onChange: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, folders: LibraryConnection[]) => listener(folders);
      ipcRenderer.on('connections:change', receive);
      return () => { ipcRenderer.removeListener('connections:change', receive); };
    },
  },
  library: {
    chooseFolder: () => invoke('library:choose-folder'),
    connect: (folder) => invoke('library:connect', folder),
    items: () => invoke('library:items'),
    progress: () => invoke('library:progress'),
    resume: () => invoke('library:resume'),
    stop: () => invoke('library:stop'),
    onProgress: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, progress: IndexingProgress) => listener(progress);
      ipcRenderer.on('library:progress', receive);
      return () => { ipcRenderer.removeListener('library:progress', receive); };
    },
  },
} satisfies ElectronBridge);
