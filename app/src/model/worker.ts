import { env, AutoProcessor, AutoTokenizer, ClapAudioModelWithProjection, ClapTextModelWithProjection } from '@huggingface/transformers';
import { MODEL_ID, MODEL_REVISION, type ModelEvent, type ModelKind, type Reply, type Request } from './types';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
// Both the web page and the Mac app are cross-origin isolated. Four threads analysed 20 real sounds 2.2 times faster with matching vectors.
env.backends.onnx.wasm!.numThreads = 4;
env.backends.onnx.wasm!.wasmPaths = {
  mjs: new URL('../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href,
  wasm: new URL('../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href,
};
let audio: ClapAudioModelWithProjection | undefined;
let text: ClapTextModelWithProjection | undefined;
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | undefined;
let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | undefined;
const send = (reply: Reply) => self.postMessage(reply);
const emit = (event: ModelEvent) => send({ type: 'event', event });

async function fetchModel(kind: ModelKind) {
  const options = {
    revision: MODEL_REVISION,
    progress_callback: (progress: { status: string; file?: string; loaded?: number; total?: number }) =>
      emit({ ...progress, type: 'progress', kind }),
  };
  if (kind === 'audio') {
    processor = await AutoProcessor.from_pretrained(MODEL_ID, options);
    audio = await ClapAudioModelWithProjection.from_pretrained(MODEL_ID, { ...options, dtype: 'q8', device: 'wasm' });
  } else {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, options);
    text = await ClapTextModelWithProjection.from_pretrained(MODEL_ID, { ...options, dtype: 'q8', device: 'wasm' });
  }
  emit({ type: 'ready', kind });
}
const loads = new Map<ModelKind, Promise<void>>();
/** One load per model; a failed one is forgotten so calling again retries it. */
function load(kind: ModelKind): Promise<void> {
  let loading = loads.get(kind);
  if (!loading) {
    loading = fetchModel(kind).catch((error) => { loads.delete(kind); throw error; });
    loads.set(kind, loading);
  }
  return loading;
}
function normalize(values: ArrayLike<number>): Float32Array {
  if (values.length !== 512) throw new Error('모델 좌표는 512개여야 합니다.');
  const result = Float32Array.from(values);
  const norm = Math.hypot(...result);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('모델 좌표가 올바르지 않습니다.');
  for (let i = 0; i < result.length; i++) result[i] /= norm;
  return result;
}
async function execute(request: Request) {
  let operation: 'load' | 'audio' | 'text' = 'load';
  try {
    await load(request.type === 'load' ? request.kind : request.type);
    const vectors: Float32Array[] = [];
    if (request.type === 'audio') {
      operation = 'audio';
      const output = await audio!(await processor!(request.samples));
      vectors.push(normalize(output.audio_embeds.data));
    } else if (request.type === 'text') {
      operation = 'text';
      for (const sentence of request.sentences) {
        const output = await text!(tokenizer!(sentence, { padding: true, truncation: true }));
        vectors.push(normalize(output.text_embeds.data));
      }
    }
    send({ type: 'result', id: request.id, vectors });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'failure', operation, message, retryable: operation === 'load' });
    send({ type: 'error', id: request.id, message });
  }
}
// Async message handlers otherwise overlap while awaiting WASM inference. Downloads run beside the queue,
// so analysis never waits for the text model to arrive (PRD 7.6).
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<Request>) => {
  if (data.type === 'load') void execute(data);
  else queue = queue.then(() => execute(data));
};
