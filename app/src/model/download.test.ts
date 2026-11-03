import { expect, it } from 'vitest';
import { DownloadTracker } from './download';

const progress = (file: string, loaded?: number, total?: number) =>
  ({ type: 'progress', kind: 'audio', status: 'progress', file, loaded, total }) as const;

it('treats files read from the cache and from the network alike: no percent at first, then only the large model file', () => {
  const tracker = new DownloadTracker();
  expect(tracker.update({ type: 'progress', kind: 'audio', status: 'initiate', file: 'config.json' })).toEqual({});
  expect(tracker.update(progress('config.json', 10, 10))).toEqual({});
  expect(tracker.update(progress('onnx/audio_model_quantized.onnx', 25, 100))).toEqual({ percent: 25 });
  expect(tracker.update({ type: 'progress', kind: 'audio', status: 'done', file: 'onnx/audio_model_quantized.onnx' })).toEqual({ percent: 25 });
});

it('ends on ready and on failure', () => {
  const tracker = new DownloadTracker();
  tracker.update(progress('a.onnx', 1, 2));
  expect(tracker.update({ type: 'ready', kind: 'audio' })).toBeUndefined();
  tracker.update(progress('a.onnx', 1, 2));
  expect(tracker.update({ type: 'failure', operation: 'load', message: 'x', retryable: true })).toBeUndefined();
  expect(tracker.state).toBeUndefined();
});
