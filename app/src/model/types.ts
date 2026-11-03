export const MODEL_ID = 'Xenova/clap-htsat-unfused';
export const MODEL_REVISION = 'c28f2883575e590e04d3146ff0713c2448d691ba';
export type ModelKind = 'audio' | 'text';
export type ModelEvent =
  | { type: 'progress'; kind: ModelKind; file?: string; loaded?: number; total?: number; status: string }
  | { type: 'ready'; kind: ModelKind }
  | { type: 'failure'; operation: 'load' | 'audio' | 'text'; message: string; retryable: boolean };
export type Operation =
  | { type: 'load'; kind: ModelKind }
  | { type: 'audio'; samples: Float32Array }
  | { type: 'text'; sentences: string[] };
export type Request = Operation & { id: number };
export type Reply =
  | { type: 'event'; event: ModelEvent }
  | { type: 'result'; id: number; vectors: Float32Array[] }
  | { type: 'error'; id: number; message: string };
