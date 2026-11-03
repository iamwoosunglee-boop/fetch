import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import type { AudioResult, PeaksResult, WorkerMode } from '../platform/library';
import type { ModelEvent } from '../model/types';

export class IndexingWindow {
  private window?: BrowserWindow;
  private ready?: Promise<void>;
  private pending?: { resolve: (result: AudioResult | PeaksResult) => void; reject: (error: Error) => void };

  constructor(private readonly onModel: (event: ModelEvent) => void) {
    ipcMain.on('indexing:result', (event, result: AudioResult | PeaksResult) => {
      if (event.sender !== this.window?.webContents) return;
      const pending = this.pending;
      this.pending = undefined;
      pending?.resolve(result);
    });
    ipcMain.on('indexing:model', (event, modelEvent: ModelEvent) => {
      if (event.sender === this.window?.webContents) this.onModel(modelEvent);
    });
  }

  audio(bytes: Uint8Array): Promise<AudioResult> {
    return this.send(bytes, 'embed') as Promise<AudioResult>;
  }

  /** Decode only, for waveforms of sounds analysed before peaks were stored. */
  peaks(bytes: Uint8Array): Promise<PeaksResult> {
    return this.send(bytes, 'peaks') as Promise<PeaksResult>;
  }

  private async send(bytes: Uint8Array, mode: WorkerMode): Promise<AudioResult | PeaksResult> {
    if (!this.window) {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(__dirname, '../preload/indexing.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true,
          backgroundThrottling: false,
        },
      });
      this.window = window;
      const failed = () => {
        this.pending?.reject(new Error('분석 창이 닫혔습니다.'));
        this.pending = undefined;
        this.window = undefined;
        this.ready = undefined;
        if (!window.isDestroyed()) window.destroy();
      };
      window.webContents.once('render-process-gone', failed);
      window.once('closed', failed);
      this.ready = window.loadURL(new URL('/indexing.html', process.env.PROTO1_DEV_URL || 'app://bundle/').href)
        .then(async () => {
          const isolated = await window.webContents.executeJavaScript('crossOriginIsolated');
          console.info('analysis window crossOriginIsolated:', isolated);
        });
    }
    await this.ready;
    if (this.pending) throw new Error('소리는 한 번에 하나씩 분석합니다.');
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.window!.webContents.send('indexing:audio', bytes, mode);
    });
  }

  close(): void {
    this.window?.destroy();
  }
}
