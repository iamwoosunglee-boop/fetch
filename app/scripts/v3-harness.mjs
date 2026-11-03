// Shared helpers for the hidden-window QA scripts: hidden Electron on a temp profile, a fake relay on a temp port,
// and no model at all: saved coordinates stand in for analysis, and a stand-in worker answers what is left.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

export const appDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const demoSounds = path.join(appDir, 'web-demo/sounds');
/** Chromium switch: no host name resolves, so a page can neither download a model nor reach a public address. */
export const offlineSwitch = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';
const LASER_SOUND = 'sounds/kenney-sci-fi-sounds/laserLarge_000.ogg';
const coordinates = async () => JSON.parse(await fs.readFile(path.join(appDir, 'web-demo/coordinates.json'), 'utf8'));

/**
 * Runs in every page before its scripts and replaces the model worker, so nothing loads a model.
 * Text gets the vector given for the sentence, or one drawn from its letters; audio one drawn from its samples.
 * localStorage drives it from a check: qa-model is 'fail', 'text-fail', 'hold', 'cached' (every byte at once, then a slow
 * start) or 'fetching' (bytes still coming for a while), and qa-audio-limit holds analysis after that many files.
 */
export function modelStub({ texts, hold }) {
  if (window.qaModelStub) return;
  window.qaModelStub = true;
  const drawn = (seed) => {
    const vector = new Float32Array(512);
    let state = seed >>> 0 || 1;
    for (let index = 0; index < vector.length; index++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
      vector[index] = state / 2 ** 31 - 1;
    }
    const norm = Math.hypot(...vector);
    return vector.map((value) => value / norm);
  };
  const fingerprint = (values) => {
    let hash = 2166136261;
    for (let index = 0; index < values.length; index += 97) hash = Math.imul(hash ^ Math.round(values[index] * 1e6), 16777619);
    return hash;
  };
  const textVector = (sentence) => (texts[sentence] ? Float32Array.from(texts[sentence]) : drawn(fingerprint(Array.from(sentence, (letter) => letter.codePointAt(0) / 1e6))));
  let analysed = 0;
  const heldAudio = [];
  class ModelWorker {
    onmessage = null;
    onerror = null;
    terminate() {}
    send(data) { setTimeout(() => this.onmessage?.({ data }), 0); }
    answerAudio({ id, samples }) {
      analysed++;
      this.send({ type: 'result', id, vectors: [drawn(fingerprint(samples))] });
    }
    postMessage(request) {
      const mode = localStorage.getItem('qa-model');
      if (request.type === 'load') {
        if (mode === 'fail') {
          this.send({ type: 'event', event: { type: 'failure', operation: 'load', message: 'no model in this check', retryable: true } });
          this.send({ type: 'error', id: request.id, message: 'no model in this check' });
        } else if (request.kind === 'text' && (hold || mode === 'hold')) {
          this.send({ type: 'event', event: { type: 'progress', kind: 'text', status: 'progress', file: 'onnx/text_model_quantized.onnx', loaded: 0, total: 100 } });
        } else {
          this.send({ type: 'event', event: { type: 'ready', kind: request.kind } });
          this.send({ type: 'result', id: request.id, vectors: [] });
        }
      } else if (request.type === 'audio') {
        const limit = localStorage.getItem('qa-audio-limit');
        if (limit !== null && analysed >= Number(limit)) heldAudio.push(() => this.answerAudio(request));
        else this.answerAudio(request);
      } else if (mode === 'text-fail') {
        this.send({ type: 'error', id: request.id, message: 'no model in this check' });
      } else if (mode === 'cached' || mode === 'fetching') {
        const loaded = mode === 'cached' ? 100 : 40;
        this.send({ type: 'event', event: { type: 'progress', kind: 'text', status: 'progress', file: 'onnx/text_model_quantized.onnx', loaded, total: 100 } });
        setTimeout(() => {
          this.send({ type: 'event', event: { type: 'ready', kind: 'text' } });
          this.send({ type: 'result', id: request.id, vectors: request.sentences.map(textVector) });
        }, 1600);
      } else if (!hold && mode !== 'hold') {
        this.send({ type: 'result', id: request.id, vectors: request.sentences.map(textVector) });
      }
    }
  }
  addEventListener('storage', () => {
    const limit = localStorage.getItem('qa-audio-limit');
    while (heldAudio.length && (limit === null || analysed < Number(limit))) heldAudio.shift()();
  });
  const RealWorker = window.Worker;
  window.Worker = function Worker(url, options) {
    return /\/worker-[^/]*\.js/.test(String(url)) ? new ModelWorker() : new RealWorker(url, options);
  };
}

/** What modelStub answers for the sentences the checks use: the laser sentence lands exactly on a laser sound. */
export async function stubTexts() {
  const { sounds } = await coordinates();
  return { 'a sci-fi laser gun shot': sounds.find((sound) => sound.id === LASER_SOUND).vector };
}

/**
 * Fills an empty profile with demo sounds as an analysed library, from tracked coordinates and waveforms.
 * place says where a manifest file lies under root, or nothing to leave it out; by default every demo sound stays where it is.
 */
export async function seedProfile(profile, { root = demoSounds, place = (file) => path.join(appDir, 'web-demo', file.path) } = {}) {
  const { sounds } = await coordinates();
  const manifest = JSON.parse(await fs.readFile(path.join(appDir, 'web-demo/manifest.json'), 'utf8'));
  const peaks = JSON.parse(await fs.readFile(path.join(appDir, 'scripts/fixtures/demo-peaks.json'), 'utf8'));
  const vectors = new Map(sounds.map((sound) => [sound.sha256, sound.vector]));
  const placed = manifest.files.flatMap((file) => { const location = place(file); return location ? [{ file, location }] : []; });
  const items = await Promise.all(placed.map(async ({ file, location }, index) => {
    const [bytes, info] = await Promise.all([fs.readFile(location), fs.stat(location)]);
    const window = Math.min(65_536, bytes.length);
    const edge = createHash('sha256').update(bytes.subarray(0, window)).update(bytes.subarray(bytes.length - window));
    return {
      id: file.sha256, fullSha256: file.sha256, edgeSha256: edge.digest('hex'), size: info.size, mtimeMs: info.mtimeMs,
      addedAt: 1_700_000_000_000 + index, duration: file.duration_seconds, peaks: peaks[file.sha256],
      paths: [{ folderId: root, path: location }],
    };
  }));
  await fs.writeFile(path.join(profile, 'items.json'), JSON.stringify(items));
  await fs.writeFile(path.join(profile, 'folders.json'), JSON.stringify([{ root }]));
  await fs.writeFile(path.join(profile, 'embeddings.jsonl'), items.map(({ id }) => `${JSON.stringify({ id, vector: vectors.get(id) })}\n`).join(''));
}

export async function evidenceDir(name) {
  const dir = path.resolve(process.env.EVIDENCE_DIR ?? path.resolve(appDir, '../../.omo/evidence'), name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Sets the app window's content size and returns once the page has handled the resize event for it. */
export async function resizeContent(app, page, width, height) {
  await page.evaluate((size) => {
    const reached = () => innerWidth === size.width && innerHeight === size.height;
    window.qaResized = reached() ? Promise.resolve() : new Promise((resolve) => {
      addEventListener('resize', function arrived() {
        if (!reached()) return;
        removeEventListener('resize', arrived);
        resolve();
      });
    });
  }, { width, height });
  await app.evaluate(({ BrowserWindow }, size) => {
    for (const window of BrowserWindow.getAllWindows()) if (window.getTitle() === 'fetch') window.setContentSize(size.width, size.height);
  }, { width, height });
  await page.evaluate(() => window.qaResized);
}

/** A relay stand-in: answers /plan with plans chosen by the request text and counts every call. planFor may be async to hold a reply. */
export async function startFakeRelay(planFor, phraseFor = (facts) => ({ message: `${facts.count}개를 가져왔어요.` })) {
  const calls = [];
  const phraseCalls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      const input = body ? JSON.parse(body) : {};
      if (request.url === '/phrase') {
        phraseCalls.push(input);
        const phrase = await phraseFor(input);
        response.writeHead(phrase.status ?? 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(phrase.body ?? phrase));
        return;
      }
      calls.push(input);
      const plan = await planFor(input);
      response.writeHead(plan.status ?? 200, { 'content-type': plan.raw ? 'text/html' : 'application/json' });
      response.end(plan.raw ?? JSON.stringify(plan.body ?? plan));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.notEqual(port, 8787, 'The fake relay must never take the user relay port');
  return { url: `http://127.0.0.1:${port}`, calls, phraseCalls, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * holdTextModel leaves the text model loading for good, as a download that never ends does.
 * seeded starts on the demo sounds as an analysed library. A given profile is reused as it is.
 * Generated temp profiles are retained to preserve WAV copies.
 */
export async function launchHidden({ relayUrl, testDrag = false, width = 1100, height = 760, holdTextModel = false, seeded = false, profile: kept } = {}) {
  assert.equal(process.env.PROTO1_HIDDEN, '1', 'Hidden mode is required');
  const profile = kept ?? await fs.mkdtemp(path.join(os.tmpdir(), 'proto1-v3-profile-'));
  if (seeded && !kept) await seedProfile(profile);
  const app = await _electron.launch({
    args: [appDir, `--user-data-dir=${profile}`, offlineSwitch],
    env: {
      ...process.env, PROTO1_HIDDEN: '1',
      ...(relayUrl ? { PROTO1_RELAY_URL: relayUrl } : { PROTO1_RELAY_URL: 'http://127.0.0.1:9' }),
      ...(testDrag ? { PROTO1_TEST_DRAG: '1' } : {}),
    },
  });
  await app.context().addInitScript(modelStub, { texts: await stubTexts(), hold: holdTextModel });
  const page = await app.firstWindow();
  // The first page can load before the script above is registered; it then has the real worker.
  if (!await page.evaluate(() => Boolean(window.qaModelStub))) await page.reload();
  // Geometry checks read final sizes; the checks of the motion itself ask for it back.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.evaluate(({ BrowserWindow }, size) => {
    for (const window of BrowserWindow.getAllWindows()) window.setContentSize(size.width, size.height);
  }, { width, height });
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())), 'Every window must stay hidden');
  await page.waitForSelector('.top');
  const close = async () => {
    await app.close().catch(() => {});
    console.log(`PROFILE_RETAINED ${profile}`);
  };
  return { app, page, profile, close };
}

/** Connects a folder through the real preload and waits until analysis is done. */
export async function connectAndAnalyse(page, root, timeout = 600_000) {
  return page.evaluate(({ root, timeout }) => new Promise((resolve, reject) => {
    const api = window.fetchApp.library;
    const timer = setTimeout(() => reject(new Error('Indexing timed out')), timeout);
    const off = api.onProgress((progress) => {
      if (progress.status === 'completed' && progress.remaining === 0) { clearTimeout(timer); off(); resolve(progress); }
      if (progress.status === 'stopped') { clearTimeout(timer); off(); reject(new Error(progress.reason)); }
    });
    window.fetchApp.connections.connectFolder(root).catch(reject);
  }), { root, timeout });
}
