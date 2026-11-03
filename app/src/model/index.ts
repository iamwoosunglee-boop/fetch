import { decodeAudio } from './audio';
import type { ModelEvent, ModelKind, Operation, Reply } from './types';
export { MODEL_ID, MODEL_REVISION } from './types';
export type { ModelEvent, ModelKind } from './types';

// One shared worker for both app and web; callers cannot start competing model workers.
let worker: Worker | undefined;
let nextId = 0;
const listeners = new Set<(event: ModelEvent) => void>();
const pending = new Map<number, { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void }>();
function emit(event: ModelEvent) {
  for (const listener of listeners) listener(event);
}
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      if (data.type === 'event') return emit(data.event);
      const request = pending.get(data.id);
      pending.delete(data.id);
      if (data.type === 'error') request?.reject(new Error(data.message));
      else request?.resolve(data.vectors);
    };
    worker.onerror = (event) => {
      emit({ type: 'failure', operation: 'load', message: event.message, retryable: true });
      disposeModel();
    };
  }
  return worker;
}
function request(operation: Operation): Promise<Float32Array[]> {
  const target = getWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({ ...operation, id }, operation.type === 'audio' ? [operation.samples.buffer] : []);
  });
}
export function onModelEvent(listener: (event: ModelEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
// Calling this again after a failure explicitly retries the download; successful files stay cached.
export async function loadModel(kind: ModelKind): Promise<void> {
  await request({ type: 'load', kind });
}
export async function embedAudio(bytes: ArrayBuffer): Promise<Float32Array> {
  let samples: Float32Array;
  try {
    samples = await decodeAudio(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'failure', operation: 'audio', message, retryable: false });
    throw error;
  }
  return (await request({ type: 'audio', samples }))[0];
}
export function embedText(sentences: string[]): Promise<Float32Array[]> {
  return request({ type: 'text', sentences });
}
export function disposeModel(): void {
  worker?.terminate();
  worker = undefined;
  for (const item of pending.values()) item.reject(new Error('모델 실행이 종료되었습니다.'));
  pending.clear();
}
