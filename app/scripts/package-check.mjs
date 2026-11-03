// Checks the packaged v3 app. First what the archive holds, then the packaged binary on a disposable profile with
// hidden windows: first run, a real folder connect with packaged audio inference, list rows, playback, an OGG drag
// copy (recorded by PROTO1_TEST_DRAG, never a real OS drag), a reference search and a normal relaunch.
// Nothing here reaches Haiku: a packaged app always uses its baked relay address, which on this machine is the
// user's own relay. A reference dropped on an empty chat input is ranked on the device (PRD v3 7.3).
// Usage: PROTO1_HIDDEN=1 nice -n 15 node scripts/package-check.mjs <packaged executable> [--audit-only]
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const executablePath = path.resolve(process.argv[2] ?? 'dist/packages/mac-arm64/fetch.app/Contents/MacOS/fetch');
assert.equal(process.env.PROTO1_HIDDEN, '1');
const root = path.resolve(import.meta.dirname, '..');
const evidence = path.resolve(process.env.EVIDENCE_DIR ?? path.resolve(root, '../../.omo/evidence/v3-package'));
await fs.mkdir(evidence, { recursive: true });
const lines = [];
const note = (text) => { lines.push(text); console.log(text); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const platformName = executablePath.endsWith('.exe') ? 'windows' : 'mac';
const resources = platformName === 'windows'
  ? path.resolve(executablePath, '../resources')
  : path.resolve(executablePath, '../../Resources');
const archive = path.join(resources, 'app.asar');
const entries = asar.listPackage(archive);
await fs.writeFile(path.join(evidence, `asar-list-${platformName}.txt`), `${entries.join('\n')}\n`);
assert(!entries.some((name) => /node_modules|onnxruntime-node|sharp|\.node$|\.dylib$|\.dll$/i.test(name)), 'Node or native modules are packaged');
// v3 removed the measure screen and the bundled demo, so neither their data nor stale compiled code may ship.
const removed = entries.filter((name) => /kr1_tasks|measure|web-demo|[\\/]demo\.js$/i.test(name));
assert.deepEqual(removed, [], `removed v2 files are packaged: ${removed.join(', ')}`);
for (const name of ['/dist/renderer/index.html', '/dist/renderer/indexing.html', '/dist/electron/main/index.js', '/dist/electron/preload/index.js']) {
  assert(entries.includes(name), `${name} is missing from the archive`);
}
const unpacked = [];
async function walk(dir, result) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(name, result);
    else if (entry.isFile()) result.push(name);
  }
}
try { await walk(`${archive}.unpacked`, unpacked); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
assert(!unpacked.some((name) => /onnxruntime-node|sharp|\.node$|\.dylib$|\.dll$/i.test(name)), `native files unpacked: ${unpacked.join(', ')}`);
let keys = 0;
for (const file of [archive, ...unpacked]) {
  const bytes = (await fs.readFile(file)).toString('latin1');
  keys += (bytes.match(/sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|ghp_[A-Za-z0-9]{36}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g) ?? []).length;
}
assert.equal(keys, 0, 'key-like strings in the archive');
const metadata = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(metadata.fetchRelayUrl, process.env.PROTO1_RELAY_URL || 'http://127.0.0.1:8787');
const assets = entries.filter((name) => /\/assets\/(worker-.*\.js|ort-.*\.(mjs|wasm))$/.test(name));
assert.equal(assets.length, 3, `worker and runtime assets: ${assets.join(', ')}`);
note(`PASS ${platformName} archive: ${entries.length} entries, no Node or native modules, no measure or demo files, no key-like strings, relay ${metadata.fetchRelayUrl}`);
if (process.argv.includes('--audit-only')) {
  await fs.writeFile(path.join(evidence, `package-check-${platformName}-audit.log`), `${lines.join('\n')}\n`);
  process.exit(0);
}

const pressure = (await exec('memory_pressure')).stdout;
const free = Number(pressure.match(/free percentage:\s*(\d+)%/)[1]);
note(`MEMORY free=${free}%`);
assert(free >= 30, 'Free memory below 30%; stopping');
let others = '';
try { others = (await exec('pgrep', ['-fl', 'scripts/verif[y]-|app-path-tes[t]|web-q[a]\\.mjs|electron-builde[r]'])).stdout; }
catch (error) { if (error.code !== 1) throw error; }
assert.equal(others.trim(), '', `Another heavy verification is running: ${others}`);
note(`HEAVY_GATE clear; nice=${(await exec('ps', ['-o', 'ni=', '-p', String(process.pid)])).stdout.trim()}`);

// Four sounds from four packs, copied so the check never writes next to the bundled test sounds.
const demo = path.join(root, 'web-demo/sounds');
const sources = [
  'kenney-digital-audio/laser1.ogg', 'kenney-sci-fi-sounds/laserSmall_000.ogg',
  'meta-oculus-audio-pack-1/AMBForst_ForestBirds_OS_01.wav', 'subspaceaudio-512/sfx_wpn_laser1.wav',
];
// The real path, because Electron reports userData without the /var -> /private/var link of the macOS temp folder.
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'proto1-package-qa-')));
const library = path.join(temp, 'Library');
const profile = path.join(temp, 'absent-profile');
const originals = new Map();
for (const file of sources) {
  const bytes = await fs.readFile(path.join(demo, file));
  await fs.mkdir(path.dirname(path.join(library, file)), { recursive: true });
  await fs.writeFile(path.join(library, file), bytes);
  originals.set(file, sha256(bytes));
}
assert.equal(await fs.access(profile).then(() => true, () => false), false);
const env = { ...process.env, PROTO1_HIDDEN: '1', PROTO1_TEST_DRAG: '1' };
delete env.PROTO1_DEV_URL;
delete env.PROTO1_RELAY_URL;
delete env.ELECTRON_RUN_AS_NODE;
const modelDir = path.resolve(root, '../_experiments/e4_browser/models/Xenova/clap-htsat-unfused');
const models = new Set();
let electron;
let current;
const consoleLines = [];
const watchPage = (page) => {
  current = page;
  page.on('console', (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => consoleLines.push(`[pageerror] ${error}`));
  return page;
};
// Each probe has its own short limit, so one hung call cannot hide the others.
const within = (promise, ms) => Promise.race([
  Promise.resolve(promise).then((value) => value, (error) => ({ rejected: String(error?.message ?? error).slice(0, 200) })),
  new Promise((resolve) => { setTimeout(() => resolve('pending'), ms); }),
]);
// Separates a screen that never got its data from a hidden window that stopped producing frames.
async function logStuckState(app, page) {
  const ask = (fn) => within(page.evaluate(fn), 3000);
  const state = {
    href: await ask(() => location.href),
    visibilityState: await ask(() => document.visibilityState),
    frameWithin1s: await ask(() => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 1000);
      requestAnimationFrame(() => { clearTimeout(timer); resolve(true); });
    })),
    mounted: await ask(() => ({
      top: Boolean(document.querySelector('.top')),
      dropzone: Boolean(document.querySelector('.dropzone')),
      rows: document.querySelectorAll('.list .row').length,
    })),
    // Playwright's own locator runs in its isolated world, unlike evaluate; pending here means Playwright, not the screen, is stuck.
    locatorCount: await within(page.locator('.top').count(), 3000),
    bodyHead: await ask(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200)),
    windows: await within(app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({
      url: window.webContents.getURL(), visible: window.isVisible(),
      loading: window.webContents.isLoading(), crashed: window.webContents.isCrashed(),
    }))), 3000),
  };
  note(`STUCK_STATE ${JSON.stringify(state)}`);
}
async function routeModels(app) {
  await app.context().route('https://huggingface.co/**', async (route) => {
    const name = route.request().url().split('/resolve/c28f2883575e590e04d3146ff0713c2448d691ba/')[1];
    assert(name, 'Model revision must remain pinned');
    models.add(name);
    const local = path.join(modelDir, name);
    const size = await fs.stat(local).then((info) => info.size, () => undefined);
    // A body this large closes the page when fulfilled through the driver, so it comes from the pinned revision.
    if (size === undefined || size > 64 * 1024 * 1024) { await route.continue(); return; }
    await route.fulfill({ path: local, headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' } });
  });
}
// Every launch checks its first load in the page's own context, because Playwright's isolated context
// can hang on a page that finished loading before it attached. Only then is a hung context replaced.
async function launchWindow(label, expected, arg, selector) {
  electron = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env });
  await routeModels(electron);
  const page = watchPage(await electron.firstWindow());
  const stuck = async (error) => {
    await logStuckState(electron, page);
    throw error;
  };
  await page.waitForFunction(expected, arg, { polling: 100, timeout: 30_000 }).catch(stuck);
  note(`PASS ${label} first load: expected state reached in the page's own context`);
  const hung = await within(page.locator(selector).count(), 2000) === 'pending';
  note(`PLAYWRIGHT_CONTEXT_HUNG ${hung} (${label})`);
  if (hung) {
    await page.reload();
    note(`RELOADED ${label}: Playwright's context hung on a correct page; later locator steps use a fresh one`);
  }
  await page.locator(selector).first().waitFor().catch(stuck);
  return page;
}
// Resolves with a WAV file once all of it is written (RIFF size plus 8 bytes); subscribe before the action that writes it.
function wavWritten(file, timeout) {
  return new Promise((resolve, reject) => {
    const read = () => fs.readFile(file).then((bytes) => {
      if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.length === bytes.readUInt32LE(4) + 8) finish(bytes);
    }, () => {});
    const watcher = watch(profile, { recursive: true }, (event, name) => { if (!name || name.includes('wav-copies')) void read(); });
    const timer = setTimeout(() => finish(undefined, new Error(`${path.basename(file)} was not written`)), timeout);
    function finish(bytes, error) {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error); else resolve(bytes);
    }
    void read();
  });
}
const firstRunState = () => {
  const zone = document.querySelector('.dropzone');
  const chat = document.querySelector('.chatbtn');
  return Boolean(zone && zone.textContent.includes('소리 폴더를 여기에 끌어다 놓거나 선택하세요') && chat?.disabled);
};
const listState = (count) => document.querySelectorAll('.list .row').length === count && !document.querySelector('.dropzone');
const rowNamed = (name) => [...document.querySelectorAll('.list .row')].find((row) => row.querySelector('.fname')?.textContent === name);

try {
  const page = await launchWindow('first run', firstRunState, undefined, '.dropzone');
  assert(page.url().startsWith('app://bundle/'), page.url());
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(await electron.evaluate(({ app }) => app.getPath('userData')), profile);
  const hidden = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible()));
  assert(await hidden(), 'every window stays hidden');
  assert.equal(await page.getByRole('button', { name: '폴더 선택하기', exact: true }).count(), 1);
  assert.equal((await page.evaluate(() => window.fetchApp.library.items())).length, 0);
  await page.screenshot({ path: path.join(evidence, 'first-run.png') });
  await page.setViewportSize({ width: 480, height: 800 });
  await page.screenshot({ path: path.join(evidence, 'first-run-narrow.png') });
  await page.setViewportSize({ width: 1100, height: 760 });
  note('PASS first run: packaged app:// page, isolated, hidden, empty library, folder drop zone with 폴더 선택하기, chat off');

  const progress = await page.evaluate(({ folder, count }) => new Promise((resolve, reject) => {
    const api = window.fetchApp.library;
    const timer = setTimeout(() => { off(); reject(new Error('Packaged analysis timed out')); }, 300_000);
    const off = api.onProgress((state) => {
      if (state.status === 'completed' && state.remaining === 0 && state.completed + state.failed >= count) { clearTimeout(timer); off(); resolve(state); }
      if (state.status === 'stopped') { clearTimeout(timer); off(); reject(new Error(state.reason)); }
    });
    window.fetchApp.connections.connectFolder(folder).catch((error) => { clearTimeout(timer); off(); reject(error); });
  }), { folder: library, count: sources.length });
  assert.equal(progress.completed, sources.length, JSON.stringify(progress));
  assert.equal(progress.failed, 0, JSON.stringify(progress));
  await page.waitForFunction(listState, sources.length, { polling: 100, timeout: 30_000 });
  const sounds = await page.evaluate(async () => (await window.fetchApp.nativeAudio.sounds())
    .map((sound) => ({ ...sound, embedding: sound.embedding ? Array.from(sound.embedding) : undefined })));
  assert.equal(sounds.length, sources.length);
  for (const sound of sounds) {
    assert.equal(sound.embedding?.length, 512, `${sound.relativePath} embedding`);
    assert(sound.embedding.every(Number.isFinite));
    assert(Math.abs(Math.hypot(...sound.embedding) - 1) < 1e-4, `${sound.relativePath} norm`);
    assert(sound.duration > 0 && sound.peaks?.length === 48 && sound.packName, `${sound.relativePath} fields`);
  }
  assert.notDeepEqual(sounds[0].embedding, sounds[1].embedding);
  assert(models.has('onnx/audio_model_quantized.onnx'), `model files: ${[...models].join(', ')}`);
  note(`PASS packaged audio inference: ${sounds.map((sound) => `${sound.relativePath} ${sound.duration.toFixed(2)}s`).join('; ')}`);
  note(`MODEL_SOURCE pinned local files fulfilled over Hugging Face URLs: ${[...models].join(', ')}`);
  const indexing = electron.windows().find((window) => window.url().includes('indexing.html'));
  assert(indexing, 'indexing window');
  assert.equal(await indexing.evaluate(() => crossOriginIsolated), true);
  for (const asset of assets) {
    const url = `app://bundle/${asset.split('/dist/renderer/')[1]}`;
    assert.equal(await page.evaluate(async (url) => (await fetch(url)).ok, url), true, url);
  }
  note(`PASS worker, WASM and runtime module load from packaged app:// assets: ${assets.join(', ')}`);

  const row = page.locator('.list .row').first();
  assert.match(await row.locator('.tile').innerText(), /^[A-Z0-9]{2}$/);
  assert([40, 64, 80].includes(await row.locator('.wave rect').count()), 'the wave follows the width of the list');
  const tallest = await row.locator('.wave rect').evaluateAll((bars) => Math.max(...bars.map((bar) => Number(bar.getAttribute('height')))));
  assert(tallest > 2, `row waveform is flat (${tallest})`);
  assert.match(await row.locator('.dur').innerText(), /^\d+\.\d{2}초$/);
  for (const part of ['.heart', '.mb']) assert.equal(await row.locator(part).count(), 1, part);
  assert.equal(await row.locator('.grip').count(), 0, 'no handle: the whole row drags');
  assert.equal(await row.getAttribute('draggable'), 'true');
  await page.screenshot({ path: path.join(evidence, 'list.png') });
  note(`PASS rows: ${sources.length} rows with pack tile, waveform (tallest ${tallest}), length, heart, menu, no handle`);

  // The bar shows the sound as soon as play starts; reaching the end with no error proves the packaged decode and playback.
  const playName = 'sfx_wpn_laser1.wav';
  await page.locator('.list .row', { hasText: playName }).locator('.play').click();
  assert.equal(await page.locator('.player .fname').innerText(), playName);
  await page.waitForFunction(() => document.querySelector('.player .pp')?.getAttribute('aria-label') === '재생', undefined, { polling: 100, timeout: 15_000 });
  assert.equal(await page.locator('.strip .err').count(), 0, 'playback ended with an error');
  note(`PASS playback: ${playName} played to its end through the packaged main process with no error`);

  // Hovering prepares the WAV copy in the renderer; the drag call is the one a row's dragstart makes.
  const ogg = sounds.find((sound) => sound.relativePath.endsWith('laser1.ogg'));
  const copyPath = path.join(profile, 'wav-copies', ogg.fullHash, 'laser1.wav');
  const written = wavWritten(copyPath, 30_000);
  await page.locator('.list .row', { hasText: 'laser1.ogg' }).hover();
  const copy = await written;
  assert.equal(copy.toString('ascii', 8, 12), 'WAVE');
  assert.equal(await page.evaluate((id) => window.fetchApp.nativeAudio.copyReady(id), ogg.id), true);
  await page.evaluate((id) => window.fetchApp.nativeAudio.drag(id), ogg.id);
  const { icon, ...entry } = JSON.parse((await fs.readFile(path.join(profile, 'drag-test.jsonl'), 'utf8')).trim().split('\n').at(-1));
  assert.deepEqual(entry, { id: ogg.id, file: copyPath });
  assert.match(icon.png, /^data:image\/png;base64,iVBOR/, 'the drag carries a picture');
  note(`PASS drag: hovering laser1.ogg made a ${copy.length}-byte WAV copy and the drag hands over that copy (recorded instead of an OS drag)`);

  await page.locator('.chatbtn').click();
  await page.locator('.compose-input').waitFor();
  assert.equal(await page.locator('.compose-input').inputValue(), '', 'an empty input keeps the drop away from Haiku');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'qa-file';
    input.hidden = true;
    document.body.append(input);
  });
  await page.setInputFiles('#qa-file', path.join(library, 'kenney-digital-audio/laser1.ogg'));
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(document.querySelector('#qa-file').files[0]);
    document.querySelector('.compose').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await page.locator('.attach .fname', { hasText: 'laser1.ogg' }).waitFor({ timeout: 30_000 });
  await page.locator('.compose-input').press('Enter');
  await page.locator('.pinned .refchip', { hasText: 'laser1.ogg' }).waitFor({ timeout: 30_000 });
  await page.locator('.ans .say', { hasText: /넣어 주신 소리와 비슷한 \d+개를 다른 팩에서/ }).waitFor({ timeout: 30_000 });
  const shown = await page.locator('.ans .crow').evaluateAll((items) => items.map((item) => item.dataset.id));
  assert.equal(shown.length, 3, `reference answer rows: ${shown.join(', ')}`);
  assert(!shown.includes(ogg.id), 'the reference is not its own result');
  await page.screenshot({ path: path.join(evidence, 'reference.png') });
  note('PASS reference search: a library file dropped on the empty chat input became the pinned reference and 3 sounds from other packs came back without Haiku');

  await electron.close();
  electron = undefined;
  const reopened = await launchWindow('normal launch', listState, sources.length, '.list .row');
  assert(await hidden(), 'every window stays hidden after the relaunch');
  await reopened.screenshot({ path: path.join(evidence, 'relaunch.png') });
  note(`PASS normal launch: the packaged binary reopens the profile with ${sources.length} rows and no drop zone`);
  for (const [file, hash] of originals) {
    assert.equal(sha256(await fs.readFile(path.join(demo, file))), hash, `${file} changed`);
    assert.equal(sha256(await fs.readFile(path.join(library, file))), hash, `${file} copy changed`);
  }
  note('PASS source files and their copies unchanged (full SHA-256)');
  const pageErrors = consoleLines.filter((line) => line.startsWith('[pageerror]'));
  assert.deepEqual(pageErrors, [], 'uncaught page errors');
  note('PASS no uncaught page errors');
} catch (error) {
  // A failed run must leave what is needed to explain it, even if the page is already gone.
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const report = path.join(evidence, `package-check-failure-${stamp}`);
  await fs.writeFile(`${report}.txt`, [`url: ${current ? current.url() : 'no window opened'}`, `error: ${error.stack}`, 'console:', ...consoleLines, ''].join('\n'));
  await current?.screenshot({ path: `${report}.png`, timeout: 10_000 }).catch((failure) => note(`SCREENSHOT_FAILED ${failure.message}`));
  note(`FAILURE_EVIDENCE ${report}`);
  throw error;
} finally {
  if (electron) await electron.close();
  note(`CLEANUP all launched Electron processes closed; temp profile and WAV copies retained at ${temp}`);
  await fs.writeFile(path.join(evidence, `package-check-${platformName}.log`), `${lines.join('\n')}\n`);
}
