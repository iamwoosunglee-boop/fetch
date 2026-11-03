import type { ModelEvent } from './types';

export interface DownloadState {
  /** Absent until the large model file reports its size. */
  percent?: number;
}

/** Small config files finish at once, so only the .onnx file gives a useful percent. */
export class DownloadTracker {
  state?: DownloadState;

  update(event: ModelEvent): DownloadState | undefined {
    if (event.type !== 'progress') {
      this.state = undefined;
    } else if (event.file?.endsWith('.onnx') && event.total) {
      this.state = { percent: Math.min(100, Math.round((event.loaded ?? 0) / event.total * 100)) };
    } else {
      this.state ??= {};
    }
    return this.state;
  }
}
