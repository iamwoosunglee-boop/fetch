import { embedAudio, loadModel, onModelEvent } from '../model';
import { computePeaks } from '../core/files';
import './library';

const bridge = window.indexingWorker!;
const decode = (buffer: ArrayBuffer) => new OfflineAudioContext(1, 1, 48_000).decodeAudioData(buffer);
const peaksOf = (decoded: AudioBuffer) =>
  computePeaks(Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel)));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

onModelEvent((event) => bridge.modelEvent(event));
bridge.onAudio(async (bytes, mode) => {
  const buffer = new Uint8Array(bytes).buffer;
  if (mode === 'peaks') {
    // Backfill decodes only; the model is never loaded for it.
    try { bridge.result({ peaks: peaksOf(await decode(buffer)) }); }
    catch (error) { bridge.result({ error: message(error), stage: 'file' }); }
    return;
  }
  try {
    await loadModel('audio');
  } catch (error) {
    bridge.result({ error: message(error), stage: 'model' });
    return;
  }
  try {
    const vector = await embedAudio(buffer);
    // Store full duration for length filtering, not the model's ten-second crop; the waveform covers the same audio.
    const decoded = await decode(buffer);
    bridge.result({ vector, duration: decoded.duration, peaks: peaksOf(decoded) });
  } catch (error) {
    bridge.result({ error: message(error), stage: 'file' });
  }
});
