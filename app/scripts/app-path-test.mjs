// The KR3 requests on the real v3 app path: the chat panel in hidden Electron, the relay code on a temp port,
// the q8 audio and text models, and the saved KR3 libraries (read only). Every request gets a fresh chat tab;
// the test records the first answer and one "더 보기" (6 sounds) and checks the pool, length and no-repeat rules.
// Haiku answers are stored by upstream request body, so --replay runs again with no API call and reports any
// change from the live run. The Vite dev server adds test-only lines to the renderer in memory (a candidate
// pool, the sound list and a folder log); no product file changes. Results go to listen_test3/v3 in the row
// shape final-score.mjs reads, so the existing human judgments can be matched to what v3 shows.
// Usage (app): npm run build && npx tsc -p server --outDir "$TMPDIR/relay" &&
//   PROTO1_HIDDEN=1 nice -n 15 node scripts/app-path-test.mjs [--replay] [--diagnose]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron } from 'playwright';
import { createServer } from 'vite';
import { savedReplies, requireReplies, createReplayRelay } from '../server/replay.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appRoot);
const lt3 = path.resolve('../_experiments/listen_test3');
const out = path.join(lt3, 'v3');
const experiments = path.dirname(lt3);
const ct = path.join(experiments, 'cls_test');
const evidence = path.resolve('../../.omo/evidence/v3-app-path');
await fs.mkdir(out, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
const exec = promisify(execFile);
const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const save = async (name, data) => fs.writeFile(path.join(out, name), JSON.stringify(data, null, 2) + '\n');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const log = [];
const note = (text) => { log.push(text); console.log(text); };
const require = createRequire(import.meta.url);
const { Store } = require('../dist/electron/main/store.js');
const replay = process.argv.includes('--replay');
const diagnose = process.argv.includes('--diagnose');
assert.equal(process.env.PROTO1_HIDDEN, '1');
const relayBase = process.env.RELAY_URL ?? 'http://127.0.0.1:8787';
const SOUND_TYPE = 'application/x-proto1-sound';
const UNAVAILABLE = '지금은 소리를 찾지 못했어요. 다시 시도해 주세요.';
const QUOTED = '이름이 일치하는 파일을 가져왔어요.';

let electron, vite, relay, before, temp;
let upstreamCalls = 0, replayed = 0, drifted = 0;
const calls = [];
const rows = [];
const modelFiles = new Set();
const responsesPath = process.env.SAVED_REPLIES ?? path.join(out, 'haiku-responses.json');
let responses = {};
try { responses = await readJson(responsesPath); } catch (e) { if (replay || e.code !== 'ENOENT') throw e; }
const saved = savedReplies(responses);
const liveRows = replay ? new Map((await readJson(path.join(out, 'app-results-v3.json'))).map((row) => [row.request, row])) : undefined;
const pools = JSON.parse((await exec('python3', [path.join(lt3, 'manifest.py')])).stdout);
const originals = await readJson(path.join(ct, 'r7_test1/api_haiku55.json'));
const mixKey = await readJson(path.join(experiments, 'listen_test/answer_key.json'));
const oldTrials = await readJson(path.join(experiments, 'listen_test/trials.json'));
const newRequests = await readJson(path.join(lt3, 'new_requests.json'));
assert.equal(new Set(newRequests).size, 10);
const requests = [
  ...originals.map((x) => ({ group: 'original', request: x.request })),
  ...mixKey.reqs.map((x) => ({ group: 'mixed', request: x.request, seed: path.resolve(oldTrials.files[String(x.seed)]) })),
  ...newRequests.map((request) => ({ group: 'new', request })),
];
if (replay) {
  requireReplies(saved, requests.map((req) => {
    const row = liveRows.get(req.request);
    const entry = responses[row?.haiku?.key];
    assert(entry, 'REPLAY_MISSING_REPLY');
    const input = entry.input ?? JSON.parse(entry.body.messages[0].content);
    assert.equal(input.text, req.request);
    assert.equal(input.has_reference, Boolean(req.seed));
    return input;
  }));
}
for (const req of mixKey.reqs) {
  assert.equal(pools.mixed[req.seed].path, path.resolve(oldTrials.files[String(req.seed)]),
    'Mixed pool ordering must reproduce the original seed');
}
assert.equal(new Set(originals.map((x) => x.request)).size, originals.length);
note(`SETS original=${originals.length} new=${newRequests.length} mixed=${mixKey.reqs.length} total=${requests.length}`);
note(`POOLS original=${pools.original.length} mixed=${pools.mixed.length}`);
const allFiles = [...new Map([...pools.original, ...pools.mixed].map((x) => [x.path, x])).values()];
const roots = [...new Set(allFiles.map((x) => x.root))];
const snapshot = async () => {
  const entries = [];
  const walk = async (dir) => {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) {
        const stat = await fs.stat(p);
        entries.push({ path: p, size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash(await fs.readFile(p)) });
      }
    }
  };
  for (const root of roots) await walk(root);
  return entries;
};
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

try {
  const pressure = (await exec('memory_pressure')).stdout;
  const free = Number(pressure.match(/free percentage:\s*(\d+)%/)[1]);
  note(`MEMORY free=${free}%`);
  assert(free >= 30, 'Free memory below 30%; no Electron model work started');
  let processes = '';
  try { processes = (await exec('pgrep', ['-fl', 'scripts/verif[y]-|electron-builde[r]|package-chec[k]|web-q[a]\\.mjs|app-path-tes[t]'])).stdout; }
  catch (e) { if (e.code !== 1) throw e; }
  const others = processes.split('\n').filter((s) => s.trim() && Number(s.split(' ')[0]) !== process.pid);
  assert.equal(others.length, 0, `Another heavy process exists: ${others.join('\n')}`);
  note(`HEAVY gate passed; pid=${process.pid}; ${String((await exec('ps', ['-o', 'ni=', '-p', String(process.pid)])).stdout).trim()} nice`);
  before = await snapshot();
  await save('source-before.json', before);
  const byPath = new Map(before.map((x) => [x.path, x]));

  // A copy-on-write clone of the KR3 run's app data, so its coordinates are reused and the original stays as it was.
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'proto1-app-path-')));
  const profile = path.join(temp, 'profile');
  await exec('cp', ['-cR', path.join(lt3, 'profile'), profile]);
  const store = new Store(profile);
  const stored = new Map(store.loadItems().data.flatMap((item) => item.paths.map((entry) => [entry.path, item])));
  for (const file of allFiles) {
    const item = stored.get(file.path);
    assert(item, `The KR3 profile lacks ${file.path}`);
    assert.equal(item.fullSha256, byPath.get(file.path)?.sha256, 'Source changed since indexing');
    assert(store.getEmbedding(item.id), `No coordinate for ${file.path}`);
  }
  note(`PROFILE cloned with ${stored.size} paths; every pool file has its coordinate`);
  await save('manifest.json', { pools, requests, newRequests: newRequests.length });

  relay = createReplayRelay({
    replay, saved, base: relayBase,
    record: async ({ key, input, status, plan, live }) => {
      if (live) {
        upstreamCalls++;
        responses[key] = { input, status, plan };
        await fs.writeFile(responsesPath, JSON.stringify(responses, null, 2) + '\n');
      } else replayed++;
      calls.push({ key, input, status, plan });
    },
  });
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
  assert.notEqual(relay.address().port, 8787, 'The test relay must never take the user relay port');
  const anchor = 'const rows = await platform.search.loadSounds();';
  vite = await createServer({
    cacheDir: path.join(temp, 'vite-cache'),
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    plugins: [{
      name: 'app-path-observer', enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/src/renderer/v3/main.ts')) return undefined;
        assert(code.includes(anchor), 'The renderer line the pool filter hooks into has moved');
        // Runs before the window loads, so the folder log sees the scan that starts after the load.
        const head = '(window as any).__appPathFolders = []; window.fetchApp?.connections.onChange((folders) => (window as any).__appPathFolders.push(folders.map((folder) => ({ root: folder.root, status: folder.status, files: folder.files.length }))));\n';
        const pooled = 'const rows = (await platform.search.loadSounds()).filter((sound) => !(window as any).__appPathPool || (window as any).__appPathPool.has(`${sound.root}/${sound.relativePath}`));';
        return `${head}${code.replace(anchor, pooled)}\n(window as any).__appPathLoad = loadSounds;\n(window as any).__appPathSounds = () => state.sounds;\n`;
      },
    }],
  });
  await vite.listen();
  electron = await _electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    env: { ...process.env, PROTO1_HIDDEN: '1', PROTO1_DEV_URL: vite.resolvedUrls.local[0],
      PROTO1_RELAY_URL: `http://127.0.0.1:${relay.address().port}` },
  });
  await electron.context().route('https://huggingface.co/**', async (route) => {
    const name = route.request().url().split('/resolve/c28f2883575e590e04d3146ff0713c2448d691ba/')[1];
    assert(name, 'Only pinned model files allowed');
    modelFiles.add(name);
    const local = path.join(experiments, 'e4_browser/models/Xenova/clap-htsat-unfused', name);
    const size = await fs.stat(local).then((info) => info.size, () => undefined);
    // A body this large closes the page when fulfilled through the driver, so it comes from the pinned revision.
    if (size === undefined || size > 64 * 1024 * 1024) { await route.continue(); return; }
    await route.fulfill({ path: local, headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' } });
  });
  const page = await electron.firstWindow();
  page.on('pageerror', (e) => note(`PAGEERROR ${e.message}`));
  await page.waitForSelector('.top', { timeout: 120_000 });
  const started = Date.now();
  // The launch rescans every saved folder; candidates may only be read once that scan and its analysis are done.
  await page.waitForFunction((roots) => {
    const folders = window.__appPathFolders ?? [];
    const last = folders.at(-1);
    return Boolean(last) && roots.every((root) => folders.some((list) => list.some((f) => f.root === root && f.status === 'scanning'))
      && last.find((f) => f.root === root)?.status === 'completed');
  }, roots, { polling: 500, timeout: 1_800_000 });
  const progress = await page.evaluate(() => window.fetchApp.library.progress());
  note(`RESCAN_DONE ${JSON.stringify(progress)} wallSeconds=${(Date.now() - started) / 1000}`);
  // Sounds analysed before v3 get their row waveforms afterwards; wait for those too, so request timings run alone.
  await page.evaluate(({ pool, timeout }) => new Promise((resolve, reject) => {
    const wanted = new Set(pool);
    let checking = false, again = false;
    const timer = setTimeout(() => { off(); reject(new Error('Waveform backfill did not finish')); }, timeout);
    const check = async () => {
      if (checking) { again = true; return; }
      checking = true;
      do {
        again = false;
        const left = (await window.fetchApp.nativeAudio.sounds())
          .filter((sound) => wanted.has(`${sound.root}/${sound.relativePath}`) && !sound.peaks?.length).length;
        if (left === 0) { clearTimeout(timer); off(); resolve(); return; }
      } while (again);
      checking = false;
    };
    // Subscribed before the first check, so the queue's last notice cannot slip between the two.
    const off = window.fetchApp.library.onProgress(() => void check());
    void check();
  }), { pool: allFiles.map((x) => x.path), timeout: 1_200_000 });
  note(`WAVEFORMS_DONE every pool sound has its row waveform; wallSeconds=${(Date.now() - started) / 1000}`);
  assert(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())));
  assert(await page.evaluate(() => crossOriginIsolated));
  await page.locator('.chatbtn').click();
  await page.locator('.compose-input').waitFor();

  const mount = async (group) => {
    const paths = pools[group === 'mixed' ? 'mixed' : 'original'].map((x) => x.path);
    const visible = await page.evaluate(async (paths) => {
      window.__appPathPool = new Set(paths);
      await window.__appPathLoad();
      return window.__appPathSounds().map((s) => ({ id: s.id, root: s.root, relativePath: s.relativePath,
        duration: s.duration, packId: s.packId, fullHash: s.fullHash, embedded: Boolean(s.embedding) }));
    }, paths);
    assert(visible.every((s) => s.embedded), 'every pool sound has a coordinate');
    // Identical files are one sound, so the count can be lower than the pool.
    note(`POOL ${group} files=${paths.length} sounds=${visible.length}`);
    return new Map(visible.map((s) => [s.id, s]));
  };
  const answerState = () => page.evaluate(() => {
    const answer = document.querySelector('.ans');
    return {
      lines: [...answer.querySelectorAll('.say')].map((line) => line.textContent.trim()),
      failed: Boolean(answer.querySelector('.say.err')),
      ids: [...answer.querySelectorAll('.crow')].map((row) => row.dataset.id),
      more: [...answer.querySelectorAll('.ans-actions button')].some((button) => button.textContent === '더 보기'),
    };
  });
  const answerDone = () => page.waitForFunction(() => document.querySelectorAll('.ans').length === 1 && !document.querySelector('.ans .dots'),
    undefined, { polling: 100, timeout: 180_000 });
  const newTab = () => page.locator('.tabs button[aria-label="새 대화"]').click();
  const closeTab = (text) => page.getByRole('button', { name: `${text.slice(0, 16)} 닫기`, exact: true }).click();

  let group, sounds;
  for (const request of requests) {
    if (request.group !== group) { group = request.group; sounds = await mount(group); }
    await newTab();
    await page.locator('.compose-input').fill(request.request);
    const callsBefore = calls.length;
    const began = Date.now();
    if (request.seed) {
      const seed = [...sounds.values()].find((s) => path.join(s.root, s.relativePath) === request.seed);
      assert(seed, `Seed is not in the mixed pool: ${request.seed}`);
      // The same drop a row dragged onto the chat input makes; it sends the typed request with the reference.
      await page.evaluate(({ id, type }) => {
        const transfer = new DataTransfer();
        transfer.setData(type, id);
        document.querySelector('.compose').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }, { id: seed.id, type: SOUND_TYPE });
      await page.locator('.attach .fname').waitFor({ timeout: 30_000 });
    }
    await page.locator('.compose-input').press('Enter');
    await answerDone();
    const milliseconds = Date.now() - began;
    const first = await answerState();
    let shown = first;
    if (first.more) {
      await page.locator('.ans .ans-actions').getByRole('button', { name: '더 보기', exact: true }).click();
      await page.waitForFunction((count) => document.querySelectorAll('.ans .crow').length > count, first.ids.length, { polling: 100, timeout: 30_000 });
      shown = await answerState();
    }
    if (rows.length === 0) await page.screenshot({ path: path.join(evidence, 'first-answer.png') });
    const made = calls.slice(callsBefore);
    assert.equal(made.length, 1, `one relay call for "${request.request}"`);
    const [call] = made;
    assert.equal(call.input.text, request.request);
    assert.equal(call.input.has_reference, Boolean(request.seed));
    assert.equal(call.input.previous_plan, null, 'a fresh tab carries no previous plan');
    assert.equal(new Set(shown.ids).size, shown.ids.length, 'no sound repeats within the answer');
    assert.deepEqual(shown.ids.slice(0, first.ids.length), first.ids, '더 보기 only appends');
    const result = (id) => {
      const sound = sounds.get(id);
      assert(sound, `Result outside the ${group} pool: ${id}`);
      return { id, root: sound.root, path: sound.relativePath, duration: sound.duration, packId: sound.packId, fullHash: sound.fullHash };
    };
    const top10 = shown.ids.map(result);
    if (request.seed) {
      const seedHash = byPath.get(request.seed).sha256;
      assert(top10.every((r) => r.fullHash !== seedHash), 'the reference is never its own result');
    }
    const max = call.plan?.max_duration_seconds;
    const min = call.plan?.min_duration_seconds;
    for (const r of top10) {
      assert(typeof max !== 'number' || r.duration <= max * 1.1 + 1e-9, `${r.path} longer than ${max}s`);
      assert(typeof min !== 'number' || r.duration >= min * 0.9 - 1e-9, `${r.path} shorter than ${min}s`);
    }
    const row = {
      ...request, haiku: { key: call.key, status: call.status, plan: call.plan }, failed: first.failed,
      line: first.lines[0], notes: first.lines.slice(1), firstCount: first.ids.length, top10, milliseconds,
      // final-score.mjs scores a mixed row by its comparisons; the app's own first three are the v3 answer.
      ...(request.seed ? { comparisons: { mean: { app: top10.slice(0, 3) } } } : {}),
    };
    if (replay) {
      const live = liveRows.get(request.request);
      assert(live, `Replay has no live row for ${request.request}`);
      const same = JSON.stringify([live.line, live.top10.map((r) => [r.root, r.path])]) === JSON.stringify([row.line, row.top10.map((r) => [r.root, r.path])]);
      if (!same) { drifted++; note(`RANK_CHANGED ${request.group} ${request.request}`); }
    }
    rows.push(row);
    await save(replay ? 'app-results-v3-replay.json' : 'app-results-v3.json', rows);
    note(`SEARCH ${rows.length}/${requests.length} ${request.group} first=${first.ids.length} shown=${shown.ids.length} failed=${first.failed} ms=${milliseconds} "${first.lines[0]}"`);
    await closeTab(request.request);
  }
  if (!replay) {
    // The first answer alone, for scoring what a person sees before pressing 더 보기.
    await save('app-results-v3-first3.json', rows.map((row) => ({ ...row, top10: row.top10.slice(0, row.firstCount) })));
  }
  const failedRows = rows.filter((row) => row.failed);
  assert.deepEqual(failedRows.map((row) => row.request), [], 'every request reached a plan');
  note(`TIMING median=${median(rows.map((row) => row.milliseconds))}ms min=${Math.min(...rows.map((row) => row.milliseconds))}ms max=${Math.max(...rows.map((row) => row.milliseconds))}ms`);

  await new Promise((resolve) => relay.close(resolve));
  relay = undefined;
  if (group !== 'new' && group !== 'original') sounds = await mount('original');
  const callsAtFallback = calls.length;
  const failureQuery = '금속';
  await newTab();
  await page.locator('.compose-input').fill(failureQuery);
  await page.locator('.compose-input').press('Enter');
  await answerDone();
  const fallback = await answerState();
  assert.equal(fallback.failed, true);
  assert.equal(fallback.lines[0], UNAVAILABLE);
  assert.deepEqual(fallback.ids, [], 'a Korean request with no file-name match shows no sounds while Haiku is down');
  await closeTab(failureQuery);
  // A quoted file name never needs the relay, so it still works with the relay closed.
  const literal = [...sounds.values()][0].relativePath;
  await newTab();
  await page.locator('.compose-input').fill(`"${literal}"`);
  await page.locator('.compose-input').press('Enter');
  await answerDone();
  const quoted = await answerState();
  assert.equal(quoted.failed, false);
  assert.equal(quoted.lines[0], QUOTED);
  assert(quoted.ids.length > 0 && quoted.ids.every((id) => sounds.has(id)));
  assert.equal(calls.length, callsAtFallback, 'nothing reached the closed relay');
  await save('fallback.json', { query: failureQuery, lines: fallback.lines, ids: fallback.ids, literal, quoted });
  note(`FALLBACK relay closed; Korean request "${failureQuery}" -> "${fallback.lines[0]}" with ${fallback.ids.length} sounds; quoted file name -> ${quoted.ids.length}`);
  if (diagnose) {
    const targets = await readJson(path.join(lt3, 'diag/targets.json'));
    const raw = [];
    for (const target of [...targets.worst, ...targets.controls]) {
      const pcm = async (args) => {
        const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', target.path, '-t', '10', '-ac', '1', ...args, '-f', 'f32le', '-'],
          { encoding: 'buffer', maxBuffer: 1 << 26 });
        return Array.from(new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength)));
      };
      const rate = Number((await exec('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', target.path])).stdout.trim());
      const result = await page.evaluate(async ({ bytes, rate, ffmpeg48, ffmpegNative }) => {
        const model = await import('/src/model/index.ts');
        const audio = await import('/src/model/audio.ts');
        // 32-bit float WAV, so Web Audio receives exactly these samples.
        const wav = (samples, sampleRate) => {
          const out = new ArrayBuffer(44 + samples.length * 4);
          const v = new DataView(out);
          const text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
          text(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 4, true); text(8, 'WAVEfmt ');
          v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 1, true);
          v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true);
          v.setUint16(32, 4, true); v.setUint16(34, 32, true); text(36, 'data'); v.setUint32(40, samples.length * 4, true);
          new Float32Array(out, 44).set(samples);
          return out;
        };
        const buffer = Uint8Array.from(bytes).buffer;
        const app = await audio.decodeAudio(buffer);
        const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(buffer.slice(0));
        const native = new Float32Array(decoded.length);
        for (let c = 0; c < decoded.numberOfChannels; c++) {
          const d = decoded.getChannelData(c);
          for (let i = 0; i < d.length; i++) native[i] += d[i] / decoded.numberOfChannels;
        }
        const f48 = Float32Array.from(ffmpeg48), fn = Float32Array.from(ffmpegNative);
        const check = await audio.decodeAudio(wav(f48, 48000));
        const embed = async (bytes) => Array.from(await model.embedAudio(bytes));
        const padded = new Float32Array(f48.length); padded.set(app.subarray(0, f48.length));
        return {
          lengths: { app: app.length, ffmpeg48: f48.length, nativeApp: native.length, ffmpegNative: fn.length, channels: decoded.numberOfChannels },
          wavIdentity: check.length === f48.length && check.every((x, i) => x === f48[i]),
          appPcm: Array.from(app.subarray(0, 48000)), nativePcm: Array.from(native.subarray(0, 48000)),
          vectors: {
            appFile: await embed(buffer),
            ffmpeg48: await embed(wav(f48, 48000)),
            ffmpegNativeChromiumResample: await embed(wav(fn, rate)),
            ffmpeg48CutToAppLength: await embed(wav(f48.slice(0, app.length), 48000)),
            appExtendedToFfmpegLength: await embed(wav(padded, 48000)),
          },
        };
      }, { bytes: [...await fs.readFile(target.path)], rate, ffmpeg48: await pcm(['-ar', '48000']), ffmpegNative: await pcm([]) });
      raw.push({ ...target, rate, ffmpegNativePcm: (await pcm([])).slice(0, 48000), ...result });
      note(`DIAG ${path.basename(target.path)} wavIdentity=${result.wavIdentity}`);
    }
    await fs.writeFile(path.join(out, 'diag-raw.json'), JSON.stringify(raw));
  }
  if (replay) assert.equal(upstreamCalls, 0);
  else assert(upstreamCalls <= requests.length, 'At most one API call per request');
  const run = { completed: true, replay, upstreamCalls, replayed, drifted, rescan: progress,
    modelFiles: [...modelFiles], hidden: true, sourceCount: before.length, requests: requests.length,
    original: originals.length, new: newRequests.length, mixed: mixKey.reqs.length };
  if (replay) note(`${drifted ? `REPLAY_DRIFT ${drifted}` : 'REPLAY_IDENTICAL'} ${rows.length} requests; upstream=0 replayed=${replayed}`);
  else note(`LIVE upstream=${upstreamCalls} replayed=${replayed}`);
  await save(replay ? 'run-replay.json' : 'run-live.json', run);
} catch (error) {
  note(`FAILED ${error.message}`);
  throw error;
} finally {
  if (electron) { await electron.close(); note('CLEANUP Electron closed'); }
  if (relay) await new Promise((resolve) => relay.close(resolve));
  if (vite) { await vite.close(); note('CLEANUP Vite and relay closed'); }
  if (temp) await fs.rm(temp, { recursive: true, force: true });
  if (before) {
    const after = await snapshot();
    await save('source-after.json', after);
    assert.deepEqual(after, before, 'Source library changed');
    note(`SOURCE_UNCHANGED ${after.length} files: paths, sizes, mtimes and full SHA-256`);
  }
  await fs.writeFile(path.join(evidence, `app-path-${replay ? 'replay' : 'live'}.log`), log.join('\n') + '\n');
}
