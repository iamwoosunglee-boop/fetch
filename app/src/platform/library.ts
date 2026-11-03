import type { ModelEvent } from '../model/types';
import type { NativeAudio, Platform, ConnectionPlatform } from './types';

export interface LibraryItem {
  id: string;
  fullSha256: string;
  paths: { folderId: string; path: string }[];
  size?: number;
  duration?: number;
  embeddingError?: string;
  /** PEAK_COUNT integers 0-100 (see StoreItem.peaks). */
  peaks?: number[];
  addedAt?: number;
  vector?: number[];
}

export interface IndexingProgress {
  status: 'idle' | 'running' | 'completed' | 'stopped';
  total: number;
  completed: number;
  failed: number;
  oversized: number;
  remaining: number;
  processed: number;
  reason?: string;
  /** Tells a model download failure from a drive failure, which need different advice. */
  failure?: 'model' | 'folder';
  model?: ModelEvent;
}

export interface LibraryPlatform {
  chooseFolder(): Promise<string | null>;
  connect(folder: string): Promise<IndexingProgress>;
  items(): Promise<LibraryItem[]>;
  progress(): Promise<IndexingProgress>;
  resume(): Promise<IndexingProgress>;
  stop(): Promise<IndexingProgress>;
  onProgress(listener: (progress: IndexingProgress) => void): () => void;
}

export type AudioResult =
  | { vector: Float32Array; duration: number; peaks: number[] }
  | { error: string; stage: 'model' | 'file' };

/** Decode-only result used to backfill waveforms of sounds analysed before peaks existed. */
export type PeaksResult = { peaks: number[] } | { error: string; stage: 'file' };

export type WorkerMode = 'embed' | 'peaks';

export interface IndexingWorkerBridge {
  onAudio(listener: (bytes: Uint8Array, mode: WorkerMode) => void): void;
  result(result: AudioResult | PeaksResult): void;
  modelEvent(event: ModelEvent): void;
}

/** What the Electron preload exposes beyond Platform; only src/platform/electron.ts uses the extras. */
export interface ElectronBridge extends Platform {
  /** Absolute path of a dropped or picked File (webUtils.getPathForFile); '' when it has none. */
  pathForFile(file: File): string;
  nativeAudio: NativeAudio & {
    /** Library item id for a stored path or a WAV copy made for dragging; null when unknown. */
    idForPath(path: string): Promise<string | null>;
    /** Library item id for a whole-file SHA-256; null when no sound has that content. */
    idForHash(hash: string): Promise<string | null>;
  };
  connections: ConnectionPlatform & {
    /** Connects the path when it is a directory; false otherwise. */
    connectPath(path: string): Promise<boolean>;
  };
}

declare global {
  interface Window {
    indexingWorker?: IndexingWorkerBridge;
  }
}
