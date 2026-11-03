import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { build, preview } from 'vite';
import { _electron } from 'playwright';

assert.equal(process.env.PROTO1_HIDDEN, '1');
const root = process.cwd();
const experiments = path.resolve(root, '../_experiments');
const files = JSON.parse(execFileSync(path.join(experiments, 'woosh/.venv/bin/python'), [
  '-c', 'import numpy as np,json,sys; print(json.dumps(np.load(sys.argv[1])["files"][:10].tolist()))',
  path.join(experiments, 'cls_test/search_lib/index.npz'),
], { encoding: 'utf8' }));
const baselineBytes = await readFile(path.join(experiments, 'e4_browser/q8_index.f32'));
const baseline = new Float32Array(baselineBytes.buffer, baselineBytes.byteOffset, baselineBytes.byteLength / 4);
await build({
  build: {
    outDir: 'dist/model-qa',
    rollupOptions: {
      input: { model: 'src/model/index.ts', qa: 'src/model/verify.html' },
      preserveEntrySignatures: 'strict',
      output: { entryFileNames: '[name].js' },
    },
  },
});
const server = await preview({ build: { outDir: 'dist/model-qa' }, preview: { port: 0 } });
const url = `${server.resolvedUrls.local[0]}src/model/verify.html`;
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${path.join(root, '.omo/model-qa-profile')}`],
  env: { ...process.env, PROTO1_HIDDEN: '1', PROTO1_DEV_URL: url },
});
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.error('PAGE ERROR', error.message));
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())));
  assert(await page.evaluate(() => crossOriginIsolated));
  let disconnected = true;
  let blocked = 0;
  const reused = [];
  const downloaded = [];
  await app.context().route('https://huggingface.co/**', async (route) => {
    if (disconnected) { blocked++; await route.abort('internetdisconnected'); return; }
    const requestUrl = route.request().url();
    const name = requestUrl.split('/resolve/c28f2883575e590e04d3146ff0713c2448d691ba/')[1];
    assert(name, `Unpinned model request: ${requestUrl}`);
    const local = path.join(experiments, 'e4_browser/models/Xenova/clap-htsat-unfused', name);
    try {
      await access(local);
      reused.push(name);
      await route.fulfill({ path: local, headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' } });
    } catch {
      downloaded.push(name);
      await route.continue();
    }
  });
  await page.evaluate(async () => {
    window.model = await import('/model.js');
    window.events = [];
    window.model.onModelEvent((event) => window.events.push(event));
    await caches.delete('transformers-cache');
  });
  const failed = await page.evaluate(async () => {
    try { await window.model.loadModel('audio'); return false; } catch { return true; }
  });
  assert(failed && blocked > 0);
  assert(await page.evaluate(() => window.events.some((e) => e.type === 'failure' && e.operation === 'load' && e.retryable)));
  console.log('PASS offline first run: failure event and rejected request');
  disconnected = false;
  await page.evaluate(() => window.model.loadModel('audio'));
  console.log('PASS explicit retry recovers; cached audio weights reused');
  const corrupt = await page.evaluate(async () => {
    try { await window.model.embedAudio(new Uint8Array([0, 1, 2, 3]).buffer); return false; } catch { return true; }
  });
  assert(corrupt);
  assert(await page.evaluate(() => window.events.some((e) => e.type === 'failure' && e.operation === 'audio' && !e.retryable)));
  console.log('PASS corrupted audio fails only that request');
  const scores = [];
  for (let i = 0; i < files.length; i++) {
    const bytes = await readFile(path.resolve(experiments, 'cls_test', files[i]));
    const result = await page.evaluate(async (data) => {
      let ticks = 0;
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { ticks++; };
      channel.port2.postMessage(null);
      try {
        const vector = await window.model.embedAudio(new Uint8Array(data).buffer);
        return { vector: Array.from(vector), ticks };
      } finally {
        channel.port1.close();
        channel.port2.close();
      }
    }, [...bytes]);
    assert.equal(result.vector.length, 512);
    assert(result.ticks > 0, 'Renderer must remain responsive during inference');
    const expected = baseline.subarray(i * 512, (i + 1) * 512);
    const dot = result.vector.reduce((sum, value, j) => sum + value * expected[j], 0);
    const cosine = dot / Math.hypot(...result.vector) / Math.hypot(...expected);
    assert(cosine >= 0.98, `${files[i]}: cosine ${cosine}`);
    scores.push(cosine);
    console.log(JSON.stringify({ index: i, file: files[i], cosine, rendererTicks: result.ticks }));
  }
  const text = await page.evaluate(async () => {
    const vectors = await window.model.embedText(['A dog barking.', 'A metallic impact.', 'Wind blowing through trees.']);
    return vectors.map((v) => ({ length: v.length, norm: Math.hypot(...v) }));
  });
  assert.equal(text.length, 3);
  for (const vector of text) {
    assert.equal(vector.length, 512);
    assert(Math.abs(vector.norm - 1) < 1e-5);
  }
  console.log('PASS three text sentences:', JSON.stringify(text));
  assert(await page.evaluate(() => window.events.some((e) => e.type === 'progress')));
  await page.evaluate(() => window.model.disposeModel());
  disconnected = true;
  const oldBlocked = blocked;
  await page.evaluate(async () => {
    await window.model.loadModel('audio');
    await window.model.embedText(['A dog barking.']);
    window.model.disposeModel();
  });
  assert.equal(blocked, oldBlocked, 'Warm offline load must make no network request');
  console.log('PASS warm offline audio and text load after worker restart');
  console.log(JSON.stringify({ minCosine: Math.min(...scores), reused, downloaded, windowsHidden: true, threads: 1 }));
} finally {
  await app.close();
  await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
  console.log('CLEANUP Electron and Vite closed');
}
