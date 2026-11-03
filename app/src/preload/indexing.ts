import { contextBridge, ipcRenderer } from 'electron';
import type { IndexingWorkerBridge, WorkerMode } from '../platform/library';

contextBridge.exposeInMainWorld('indexingWorker', {
  onAudio: (listener) => {
    ipcRenderer.on('indexing:audio', (_event, bytes: Uint8Array, mode: WorkerMode = 'embed') => listener(bytes, mode));
  },
  result: (result) => ipcRenderer.send('indexing:result', result),
  modelEvent: (event) => ipcRenderer.send('indexing:model', event),
} satisfies IndexingWorkerBridge);
