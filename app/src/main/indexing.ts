import { access, readFile } from 'node:fs/promises';
import { embeddingEligible } from '../core/files';
import type { AudioResult, IndexingProgress, LibraryItem, PeaksResult } from '../platform/library';
import { Store } from './store';

export class IndexingQueue {
  private status: IndexingProgress['status'] = 'idle';
  private reason?: string;
  private failure?: IndexingProgress['failure'];
  private processed = 0;
  private running?: Promise<void>;
  private closed = false;
  currentFolder?: string;

  constructor(
    private readonly store: Store,
    private readonly audio: (bytes: Uint8Array) => Promise<AudioResult>,
    private readonly notify: (progress: IndexingProgress) => void,
    /** Decode-only waveform backfill; it runs after analysis and reports the queue as completed. */
    private readonly peaks?: (bytes: Uint8Array) => Promise<PeaksResult>,
  ) {}

  progress(): IndexingProgress {
    const items = this.store.loadItems().data;
    const completed = items.filter((item) => this.store.getEmbedding(item.id)).length;
    const failed = items.filter((item) => item.embeddingError && !this.store.getEmbedding(item.id)).length;
    const oversized = items.filter((item) => item.size !== undefined && !embeddingEligible(item.size)).length;
    return {
      status: this.status, total: items.length, completed, failed, oversized,
      remaining: items.length - completed - failed - oversized,
      processed: this.processed, reason: this.reason, failure: this.failure,
    };
  }

  items(): LibraryItem[] {
    return this.store.loadItems().data.map((item) => {
      const vector = this.store.getEmbedding(item.id);
      return { ...item, ...(vector ? { vector: Array.from(vector) } : {}) };
    });
  }

  stop(reason = '분석을 멈췄습니다.', failure?: IndexingProgress['failure']): IndexingProgress {
    this.status = 'stopped';
    this.reason = reason;
    this.failure = failure;
    this.currentFolder = undefined;
    this.store.flush();
    this.notify(this.progress());
    return this.progress();
  }

  run(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.status = 'running';
    this.reason = undefined;
    this.failure = undefined;
    this.processed = 0;
    // Assign before notifying so a progress listener cannot start a second run.
    this.running = Promise.resolve().then(() => this.process()).finally(() => {
      this.currentFolder = undefined;
      this.store.flush();
      this.running = undefined;
      this.notify(this.progress());
    });
    this.notify(this.progress());
    return this.running;
  }

  private async process(): Promise<void> {
    // Paths that could not be read for a waveform this run; analysis itself never waits on them.
    const unreadable = new Set<string>();
    try {
      while (this.status !== 'stopped') {
        const items = this.store.loadItems().data;
        const item = items.find((candidate) =>
          !this.store.getEmbedding(candidate.id) && !candidate.embeddingError &&
          (candidate.size === undefined || embeddingEligible(candidate.size)));
        if (!item) {
          const old = this.peaks && items.find((candidate) => candidate.peaks === undefined &&
            this.store.getEmbedding(candidate.id) && !unreadable.has(candidate.id));
          if (!old) {
            this.status = 'completed';
            break;
          }
          this.status = 'completed';
          await this.backfill(old.id, old.paths[0], unreadable);
          continue;
        }
        if (this.status === 'completed') {
          // A scan added sounds while waveforms were being backfilled.
          this.status = 'running';
          this.notify(this.progress());
        }
        const location = item.paths[0];
        this.currentFolder = location.folderId;
        this.notify(this.progress());
        let bytes: Buffer;
        try {
          await access(location.folderId);
          bytes = await readFile(location.path);
        } catch {
          this.stop(`폴더나 파일을 읽을 수 없어 분석을 멈췄습니다: ${location.path}`, 'folder');
          break;
        }
        if (this.status !== 'running') break;
        const result = await this.audio(bytes);
        if (this.closed) return;
        if ('error' in result && result.stage === 'model') {
          this.stop('AI 모델을 받지 못했습니다.', 'model');
          break;
        }
        // Read again: a folder may have been removed while the worker was busy.
        const latest = this.store.loadItems().data;
        const current = latest.find((candidate) => candidate.id === item.id);
        if (!current) continue;
        if ('error' in result) current.embeddingError = result.error;
        else { current.duration = result.duration; current.peaks = result.peaks; }
        this.store.saveAnalysis(current, 'error' in result ? undefined : result.vector);
        this.processed++;
        this.notify(this.progress());
      }
    } catch (error) {
      this.stop(`분석을 멈췄습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async backfill(id: string, location: { folderId: string; path: string }, unreadable: Set<string>) {
    let bytes: Buffer;
    try {
      await access(location.folderId);
      bytes = await readFile(location.path);
    } catch {
      unreadable.add(id);
      return;
    }
    const result = await this.peaks!(bytes);
    if (this.closed) return;
    const latest = this.store.loadItems().data;
    const current = latest.find((candidate) => candidate.id === id);
    if (!current) return;
    // An undecodable file keeps an empty waveform so it is not decoded again on every run.
    current.peaks = 'error' in result ? [] : result.peaks;
    this.store.saveAnalysis(current);
    this.notify(this.progress());
  }

  close(): void {
    this.closed = true;
    this.stop();
  }
}
