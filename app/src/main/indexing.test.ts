import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioResult, IndexingProgress } from '../platform/library';
import { IndexingQueue } from './indexing';
import { Store } from './store';

let directory: string;
let library: string;
let store: Store;
const vector = new Float32Array(512).fill(1 / Math.sqrt(512));
const peaks = Array.from({ length: 48 }, (_, i) => i);

beforeEach(() => {
  fs.mkdirSync('.omo', { recursive: true });
  directory = fs.mkdtempSync(path.resolve('.omo/indexing-test-'));
  library = path.join(directory, 'library');
  fs.mkdirSync(library);
  store = new Store(path.join(directory, 'data'));
  store.saveItems([0, 1, 2].map((i) => {
    const file = path.join(library, `${i}.wav`);
    fs.writeFileSync(file, Buffer.from([i]));
    return {
      id: String(i), fullSha256: String(i).repeat(64), size: 1,
      paths: [{ folderId: library, path: file }],
    };
  }));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('indexing queue', () => {
  it('exposes each result immediately, flushes on stop and resumes only unfinished items', async () => {
    const processed: number[] = [];
    const audio = vi.fn(async (bytes: Uint8Array): Promise<AudioResult> => {
      processed.push(bytes[0]);
      return { vector, duration: 12, peaks };
    });
    let stopped = false;
    const queue = new IndexingQueue(store, audio, (progress) => {
      if (progress.completed === 1 && !stopped) {
        stopped = true;
        expect(store.getEmbedding('0')).toEqual(vector);
        expect(queue.items().filter((item) => item.vector)).toHaveLength(1);
        queue.stop();
      }
    });
    await queue.run();
    expect(queue.progress()).toMatchObject({ status: 'stopped', completed: 1, remaining: 2 });
    const reopened = new Store(path.join(directory, 'data'));
    const resumed = new IndexingQueue(reopened, audio, () => {});
    await resumed.run();
    expect(processed).toEqual([0, 1, 2]);
    expect(resumed.progress()).toMatchObject({ status: 'completed', completed: 3, processed: 2, remaining: 0 });
    expect(reopened.loadItems().data.every((item) => item.duration === 12)).toBe(true);
    expect(reopened.loadItems().data.every((item) => item.peaks?.length === 48)).toBe(true);
  });

  it('backfills waveforms of analysed sounds by decoding only, after analysis, as a completed queue', async () => {
    for (const id of ['0', '1']) store.appendEmbedding(id, vector);
    const order: string[] = [];
    const audio = vi.fn(async (bytes: Uint8Array): Promise<AudioResult> => {
      order.push(`embed ${bytes[0]}`);
      return { vector, duration: 1, peaks };
    });
    const statuses: string[] = [];
    const decode = vi.fn(async (bytes: Uint8Array) => {
      order.push(`peaks ${bytes[0]}`);
      statuses.push(queue.progress().status);
      return bytes[0] === 1 ? { error: 'decode failed', stage: 'file' as const } : { peaks };
    });
    const queue = new IndexingQueue(store, audio, () => {}, decode);
    await queue.run();
    expect(order).toEqual(['embed 2', 'peaks 0', 'peaks 1']);
    expect(statuses).toEqual(['completed', 'completed']);
    expect(store.loadItems().data.map((item) => item.peaks?.length)).toEqual([48, 0, 48]);
    await queue.run();
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('counts corrupt files and oversized files without preventing later valid sounds', async () => {
    const items = store.loadItems().data;
    items[1].size = 100_000_001;
    store.saveItems(items);
    const audio = vi.fn(async (bytes: Uint8Array): Promise<AudioResult> => bytes[0] === 0
      ? { error: 'decode failed', stage: 'file' } : { vector, duration: 1, peaks });
    const queue = new IndexingQueue(store, audio, () => {});
    await queue.run();
    expect(audio).toHaveBeenCalledTimes(2);
    expect(queue.progress()).toMatchObject({ status: 'completed', completed: 1, failed: 1, oversized: 1, remaining: 0 });
    expect(new Store(path.join(directory, 'data')).loadItems().data[0].embeddingError).toBe('decode failed');
  });

  it('stops on a disappearing drive, retains saved vectors and reports a reason', async () => {
    const audio = vi.fn(async (): Promise<AudioResult> => ({ vector, duration: 1, peaks }));
    const queue = new IndexingQueue(store, audio, (progress) => {
      if (progress.completed === 1 && progress.status === 'running') {
        fs.renameSync(library, `${library}-offline`);
      }
    });
    await queue.run();
    expect(audio).toHaveBeenCalledTimes(1);
    expect(queue.progress()).toMatchObject({ status: 'stopped', completed: 1, remaining: 2, failed: 0 });
    expect(queue.progress().reason).toBeTruthy();
    expect(new Store(path.join(directory, 'data')).getEmbedding('0')).toEqual(vector);
    fs.renameSync(`${library}-offline`, library);
    const resumed = new IndexingQueue(store, audio, () => {});
    await resumed.run();
    expect(resumed.progress()).toMatchObject({ completed: 3, processed: 2 });
  });

  it('keeps model failures retryable without marking a sound corrupt', async () => {
    const audio = vi.fn<(_: Uint8Array) => Promise<AudioResult>>()
      .mockResolvedValueOnce({ vector, duration: 1, peaks })
      .mockResolvedValueOnce({ error: 'offline', stage: 'model' })
      .mockResolvedValue({ vector, duration: 1, peaks });
    const queue = new IndexingQueue(store, audio, () => {});
    await queue.run();
    expect(queue.progress()).toMatchObject({ status: 'stopped', completed: 1, failed: 0, remaining: 2, failure: 'model' });
    expect(new Store(path.join(directory, 'data')).getEmbedding('0')).toEqual(vector);
    await queue.run();
    expect(queue.progress()).toMatchObject({ status: 'completed', completed: 3 });
  });

  it('runs only one processor and drains the in-flight save when stopped', async () => {
    let finish!: (result: AudioResult) => void;
    let started!: () => void;
    const signal = new Promise<void>((resolve) => { started = resolve; });
    const audio = vi.fn(() => new Promise<AudioResult>((resolve) => {
      finish = resolve;
      started();
    }));
    const events: IndexingProgress[] = [];
    const queue = new IndexingQueue(store, audio, (progress) => events.push(progress));
    const first = queue.run();
    expect(queue.run()).toBe(first);
    await signal;
    queue.stop();
    finish({ vector, duration: 1, peaks });
    await first;
    expect(audio).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ status: 'stopped', completed: 1, remaining: 2 });
  });
});
