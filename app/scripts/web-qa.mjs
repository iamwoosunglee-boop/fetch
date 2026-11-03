// Drives the web platform API in headless Chromium: OPFS folder, analysis with the stand-in model worker, IndexedDB persistence, download.
// Builds nothing: run `npm run build:web` first (or point WEB_ROOT at another built bundle).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createWebServer } from './serve-web.mjs';
import { modelStub, offlineSwitch } from './v3-harness.mjs';

const evidence = path.resolve(process.env.EVIDENCE_DIR ?? '../../.omo/evidence/v3-lane-d');
const webRoot = path.resolve(process.env.WEB_ROOT ?? 'dist/web');
const executablePath = process.env.CHROMIUM_PATH ?? path.resolve('../_experiments/e4_browser/browsers/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium');
await mkdir(evidence, { recursive: true });
const lines = [];
const log = (message) => { lines.push(message); console.log(message); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

// Twelve WAV files from three packs of the bundled test sounds.
const source = path.resolve('web-demo/sounds');
const sounds = [];
for (const pack of (await readdir(source)).filter((name) => !name.startsWith('.')).sort()) {
  const wavs = (await readdir(path.join(source, pack))).filter((name) => name.endsWith('.wav')).sort().slice(0, 4);
  for (const name of wavs) {
    const bytes = await readFile(path.join(source, pack, name));
    sounds.push({ path: `${pack}/${name}`, base64: bytes.toString('base64'), sha256: sha256(bytes), size: bytes.length });
  }
  if (sounds.length >= 12) break;
}
assert.equal(sounds.length, 12, 'need 12 WAV test files');

const plan = {
  english_queries: ['A short metal impact.'], name_keywords: ['impact'], min_duration_seconds: null,
  max_duration_seconds: 2, explanation: '짧은 금속 충돌 소리를 찾습니다.', result_count: 3,
};
let relayRequests = 0;
const relay = createServer((req, res) => {
  if (req.url === '/plan') relayRequests++;
  req.resume().on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(plan)); });
});
const relayPort = await listen(relay);
const server = createWebServer({ root: webRoot, relay: `http://127.0.0.1:${relayPort}` });
const port = await listen(server);
const profile = await mkdtemp(path.join(os.tmpdir(), 'proto1-web-qa-'));
const downloads = await mkdtemp(path.join(os.tmpdir(), 'proto1-web-qa-downloads-'));
const errors = [];
const outside = [];
let context;
let failed = false;
try {
  log(`SERVE ${webRoot} on 127.0.0.1:${port}, fake relay on 127.0.0.1:${relayPort}`);
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, acceptDownloads: true, downloadsPath: downloads, viewport: { width: 1440, height: 900 }, args: [offlineSwitch],
  });
  await context.addInitScript(modelStub, { texts: {}, hold: false });
  context.on('request', (request) => { if (!/^(http:\/\/127\.0\.0\.1|blob:|data:)/.test(request.url())) outside.push(request.url()); });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${port}/?proto1-test-opfs=1`;
  await page.goto(url, { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => typeof window.__proto1TestConnectOpfs), 'function', 'test hook missing');
  assert.equal(await page.evaluate(() => window.__proto1Platform?.kind), 'web');
  assert.equal(await page.evaluate(() => crossOriginIsolated), true, 'COOP/COEP headers missing');
  await page.locator('.dropzone').waitFor();
  await page.locator('#splash').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.nav').isVisible(), true, 'a wide window starts with the menu bar open');
  assert.equal(await page.locator('.head .count').count(), 0, 'no sound count before a folder exists');
  assert.equal(await page.locator('.filters.dim').count(), 1, 'nothing to filter before a folder exists');
  assert.deepEqual(await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].map((font) => `${font.family} ${font.status}`); }), ['Pretendard loaded'], 'the bundled font is in use');
  assert.match(await page.evaluate(async () => (await fetch(document.querySelector('link[rel=license]').href)).text()), /SIL OPEN FONT LICENSE/, 'the font license ships with it');
  assert.match(await page.locator('.dropzone .eg').getAttribute('href'), /fetch-example-sounds\.zip$/, 'example sounds link');
  await page.screenshot({ path: path.join(evidence, 'web-ui-first-run.png') });

  await page.evaluate(async (files) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('QA Library', { create: true });
    for (const file of files) {
      const [pack, name] = file.path.split('/');
      const folder = await root.getDirectoryHandle(pack, { create: true });
      const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
      await writable.write(Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0)));
      await writable.close();
    }
  }, sounds);
  log(`PASS wrote ${sounds.length} WAV files into OPFS "QA Library"`);

  // What a pack folder says about itself: the middle pack with a broken pack.json, the last with a cover, its facts and a license.
  const [, brokenPack, coverPack] = [...new Set(sounds.map((sound) => sound.path.split('/')[0]))];
  await page.evaluate(async ({ broken, covered }) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('QA Library');
    const write = async (pack, name, content) => {
      const writable = await (await (await root.getDirectoryHandle(pack)).getFileHandle(name, { create: true })).createWritable();
      await writable.write(content);
      await writable.close();
    };
    const canvas = new OffscreenCanvas(8, 8);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 8, 8);
    await write(covered, 'cover.png', await canvas.convertToBlob({ type: 'image/png' }));
    await write(covered, 'pack.json', JSON.stringify({ name: 'Web Deck', creator: 'QA Studio', license: 'CC0', source: 'https://example.test/web' }));
    await write(covered, 'LICENSE.txt', 'CC0');
    await write(broken, 'pack.json', '{ not json');
    await write(broken, 'cover.png', 'not an image, only a name that looks like one');
  }, { broken: brokenPack, covered: coverPack });

  // Subscribes to connection snapshots before connecting; resolves on the completed snapshot.
  const run = await page.evaluate(() => new Promise((resolve, reject) => {
    const connections = window.__proto1Platform.connections;
    const marks = [];
    let downloadSeen = false;
    const timer = setTimeout(() => reject(new Error('analysis timeout')), 15 * 60_000);
    const start = performance.now();
    const stop = connections.onChange((folders) => {
      const folder = folders.find((item) => item.root === 'QA Library');
      if (!folder) return;
      if (folder.download) downloadSeen = true;
      if (folder.completed > (marks.at(-1)?.completed ?? 0)) marks.push({ completed: folder.completed, at: performance.now() - start });
      if (folder.status === 'completed' || folder.status === 'stopped') {
        clearTimeout(timer); stop();
        resolve({ folder, marks, downloadSeen, total: performance.now() - start });
      }
    });
    window.__proto1TestConnectOpfs('QA Library').catch(reject);
  }));
  assert.equal(run.folder.status, 'completed', `analysis stopped: ${run.folder.reason}`);
  assert.deepEqual([run.folder.completed, run.folder.failed, run.folder.skipped], [12, 0, 0]);
  const steady = run.marks.length > 1 ? (run.marks.at(-1).at - run.marks[0].at) / (run.marks.length - 1) : NaN;
  log(`PASS analysis completed 12/12 in ${(run.total / 1000).toFixed(1)} s; first file (incl. model load) at ${(run.marks[0].at / 1000).toFixed(1)} s; then ${steady.toFixed(0)} ms per file; model download state reported=${run.downloadSeen}`);

  const rows = await page.evaluate(() => window.__proto1Platform.search.loadSounds());
  const check = (rows, label) => {
    assert.equal(rows.length, 12, `${label}: row count`);
    for (const sound of sounds) {
      const row = rows.find((item) => item.relativePath === sound.path);
      assert(row, `${label}: ${sound.path} missing`);
      assert.equal(row.fullHash, sound.sha256, `${label}: ${sound.path} hash`);
      assert.equal(row.peaks?.length, 48, `${label}: ${sound.path} peaks`);
      assert(row.peaks.every((value) => value >= 0 && value <= 1) && row.peaks.some((value) => value > 0), `${label}: peak range`);
      assert.equal(row.embedding?.length, 512, `${label}: ${sound.path} embedding`);
      assert(row.duration > 0 && row.packName === sound.path.split('/')[0] && row.addedAt > 0 && row.root === 'QA Library', `${label}: fields`);
    }
  };
  check(rows, 'first load');
  log(`PASS loadSounds: 12 rows with sha256, 48 peaks in 0..1, 512-d embedding, duration, packName, addedAt (sample peaks ${rows[0].peaks.slice(0, 6).map((v) => v.toFixed(2)).join(',')})`);

  const result = await page.evaluate(() => window.__proto1Platform.search.plan({ text: '짧은 금속 충돌 3개', hasReference: false }, new AbortController().signal));
  assert.equal(result.message, plan.explanation);
  assert.equal(result.count, 3);
  assert.deepEqual(result.length, { min: undefined, max: 2 });
  assert.equal(relayRequests, 1);
  const vectors = await page.evaluate(async (sentences) => (await window.__proto1Platform.search.embedText(sentences, new AbortController().signal)).map((v) => v.length), result.sentences);
  assert.deepEqual(vectors, [512]);
  log(`PASS same-origin /plan through the fake relay: explanation "${result.message}", count ${result.count}; text embedding 512-d`);

  const favorite = rows[0].fullHash;
  await page.evaluate((hash) => window.__proto1Platform.collections.save({ collections: [], searches: [], favorites: [hash] }), favorite);

  await page.reload({ waitUntil: 'load' });
  const reopened = await page.evaluate(() => new Promise((resolve, reject) => {
    const connections = window.__proto1Platform.connections;
    const timer = setTimeout(() => reject(new Error('rescan timeout')), 120_000);
    const start = performance.now();
    let analysing = false;
    const stop = connections.onChange((folders) => {
      const folder = folders.find((item) => item.root === 'QA Library');
      if (folder?.download) analysing = true;
      if (folder?.status === 'completed') { clearTimeout(timer); stop(); resolve({ folder, analysing, ms: performance.now() - start }); }
    });
    // The reopened page rescans; a completed snapshot that was already in place also counts.
    connections.getFolders().then((folders) => {
      const folder = folders.find((item) => item.root === 'QA Library');
      if (!folder) { clearTimeout(timer); stop(); reject(new Error('folder not persisted')); }
      if (folder?.status === 'completed') { clearTimeout(timer); stop(); resolve({ folder, analysing, ms: performance.now() - start }); }
    });
  }));
  assert.equal(reopened.folder.completed, 12);
  assert.equal(reopened.analysing, false, 'reload must not load the model to analyse again');
  const persisted = await page.evaluate(() => window.__proto1Platform.search.loadSounds());
  check(persisted, 'after reload');
  for (const row of persisted) {
    assert.deepEqual(row.embedding, rows.find((item) => item.id === row.id).embedding, 'embedding changed after reload');
    assert.equal(row.addedAt, rows.find((item) => item.id === row.id).addedAt);
  }
  assert.deepEqual((await page.evaluate(() => window.__proto1Platform.collections.load())).favorites, [favorite]);
  log(`PASS reload: folder and 12 sounds persisted in IndexedDB, rescan reused every analysis (${reopened.ms.toFixed(0)} ms, no model load), favorites kept`);

  const dropped = await page.evaluate(async (file) => window.__proto1Platform.search.soundIdForFile(
    new File([Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))], 'renamed.wav')), sounds[5]);
  assert.equal(dropped, `QA Library/${sounds[5].path}`);
  log(`PASS soundIdForFile matched a renamed copy by hash: ${dropped}`);

  // The v3 screen on the same data: rows, a chat answer through the fake relay, download from a row.
  await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 12, null, { timeout: 30_000 });
  const uiRow = page.locator('.list .row').first();
  assert.match(await uiRow.locator('.tile').innerText(), /^[A-Z0-9]{2}$/, 'two-letter pack tile');
  assert.equal(await uiRow.locator('.wave rect').count(), 80, 'row waveform');
  await uiRow.hover();
  assert.equal(await uiRow.getByRole('button', { name: '다운로드' }).count(), 1, 'web rows offer download on hover');
  assert.equal(await uiRow.locator('.grip').count(), 0, 'no handle: the whole row drags');
  await page.locator('.list .row').nth(1).hover();
  assert.equal(await uiRow.locator('.dl').evaluate((button) => getComputedStyle(button).visibility), 'hidden', 'download shows on the row under the pointer only');
  await uiRow.hover();
  await page.screenshot({ path: path.join(evidence, 'web-ui-list.png') });
  const uiName = await uiRow.locator('.fname').innerText();
  const uiSound = sounds.find((sound) => sound.path.endsWith(`/${uiName}`));
  const [uiDownload] = await Promise.all([page.waitForEvent('download'), uiRow.getByRole('button', { name: '다운로드' }).click()]);
  const uiSaved = path.join(downloads, `ui-${uiDownload.suggestedFilename()}`);
  await uiDownload.saveAs(uiSaved);
  assert.equal(sha256(await readFile(uiSaved)), uiSound.sha256, 'row download keeps the original bytes');
  const before = relayRequests;
  await page.locator('.chatbtn').click();
  await page.locator('.compose-input').fill('짧은 금속 충돌 3개');
  await page.locator('.compose-input').press('Enter');
  await page.waitForFunction(() => !document.querySelector('.ans .dots') && document.querySelectorAll('.ans .crow').length > 0, null, { timeout: 120_000 });
  // This relay answers /phrase with a plan, which is no sentence, so the app's own stands (PRD 7.3).
  const answerLine = await page.locator('.ans .say').first().innerText();
  assert.match(answerLine, /\d+개(를|만) (먼저 )?(가져왔어요|골랐어요)/, 'answer line');
  const answered = await page.locator('.ans .crow').count();
  assert(answered >= 1 && answered <= 3, `chat shows up to the 3 results the plan asked for, got ${answered}`);
  assert.equal(relayRequests - before, 1, 'one chat request reached the relay');
  await page.screenshot({ path: path.join(evidence, 'web-ui-chat.png') });
  await page.setViewportSize({ width: 1100, height: 728 });
  await page.waitForFunction(() => innerWidth === 1100 && !document.querySelector('.list .wave'));
  const fit = await page.evaluate(() => {
    const list = document.querySelector('.list');
    const rows = [...list.querySelectorAll('.row')];
    return { list: list.clientWidth, content: list.scrollWidth, clipped: rows.filter((row) => row.scrollWidth > row.clientWidth).length, waves: list.querySelectorAll('.wave').length };
  });
  assert(fit.clipped === 0 && fit.content <= fit.list && fit.waves === 0, `rows overflow with menu and chat open: ${JSON.stringify(fit)}`);
  await page.screenshot({ path: path.join(evidence, 'web-ui-nav-chat.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => innerWidth === 1440);
  log(`PASS web screen: 12 rows with tile, waveform and download; row download sha256 matches; chat answer "${answerLine}" with ${answered} results`);

  await page.locator('.chatbtn').click();
  await page.locator('.nav-i', { hasText: '팩' }).click();
  await page.locator('.pk').first().waitFor();
  const cards = await page.locator('.pk').evaluateAll((items) => Object.fromEntries(items.map((card) => [card.getAttribute('aria-label'), {
    name: card.querySelector('.fname').textContent, cover: Boolean(card.querySelector('.tile img')), letters: card.querySelector('.tile').textContent,
  }])));
  assert.deepEqual(cards[coverPack], { name: 'Web Deck', cover: true, letters: '' }, 'the cover and the name from pack.json');
  assert.equal(cards[brokenPack].cover, false, 'a file that only looks like a cover is ignored');
  assert.match(cards[brokenPack].letters, /^[A-Z0-9]{2}$/, 'the letter tile stands in');
  assert.notEqual(cards[brokenPack].name, 'Web Deck');
  await page.locator(`.pk[aria-label="${coverPack}"]`).click();
  await page.locator('.packtop .cover img').waitFor();
  const facts = await page.locator('.pmeta').innerText();
  for (const fact of ['QA Studio', 'CC0', 'example.test/web']) assert(facts.includes(fact), `pack facts: ${facts}`);
  assert.equal(await page.getByRole('button', { name: 'Finder에서 보기' }).count(), 0, 'the web has no Finder');
  assert.equal(await page.locator('.list .row').first().locator('.tile img').count(), 1, 'the cover in the row');
  await page.screenshot({ path: path.join(evidence, 'web-ui-pack.png') });
  const dragged = await page.evaluate(() => {
    const row = document.querySelector('.list .row');
    const transfer = new DataTransfer();
    const pictures = [];
    transfer.setDragImage = (picture, x, y) => pictures.push({ tag: picture.tagName, size: [picture.width, picture.height], at: [x, y], pixel: [...picture.getContext('2d').getImageData(4, 32, 1, 1).data] });
    row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    return { pictures, sound: transfer.getData('application/x-proto1-sound'), wanted: row.dataset.id };
  });
  assert.deepEqual(dragged.pictures, [{ tag: 'CANVAS', size: [64, 64], at: [32, 32], pixel: [255, 0, 0, 255] }], 'setDragImage gets the cover');
  assert.equal(dragged.sound, dragged.wanted, 'the drag carries the sound');
  await page.locator('[aria-label="뒤로"]').click();
  await page.locator('.pk').first().waitFor();
  log('PASS web packs: cover and pack.json through the folder handle, a fake cover and bad pack.json ignored, no Finder button, setDragImage with the cover, back returns');

  await page.locator('.nav-i', { hasText: '모든 소리' }).click();
  await page.locator('.list .row').first().locator('.names').click();
  await page.locator('.player').waitFor();
  await page.locator('.slider').fill('40');
  await page.locator('[aria-label="음소거"]').click();
  await page.keyboard.press('Escape');
  await page.locator('.nav-i', { hasText: '설정' }).click();
  await page.screenshot({ path: path.join(evidence, 'web-ui-settings.png') });
  assert.equal(await page.getByRole('button', { name: '내보내기', exact: true }).count(), 0, 'no CSV row');
  log('PASS web settings: no CSV row');
  await page.locator('.nav-i', { hasText: '모든 소리' }).click();

  const target = persisted.find((row) => row.relativePath === sounds[3].path);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate((sound) => window.__proto1Platform.search.download(sound), target),
  ]);
  const saved = path.join(downloads, download.suggestedFilename());
  await download.saveAs(saved);
  const bytes = await readFile(saved);
  assert.equal(download.suggestedFilename(), sounds[3].path.split('/')[1]);
  assert.equal(sha256(bytes), sounds[3].sha256);
  log(`PASS download: ${download.suggestedFilename()} ${bytes.length} bytes, sha256 ${sha256(bytes)} matches the original`);

  await page.screenshot({ path: path.join(evidence, 'web-qa-page.png') });

  await page.setViewportSize({ width: 480, height: 728 });
  await page.reload({ waitUntil: 'load' });
  await page.locator('.list .row').first().waitFor({ timeout: 30_000 });
  await page.locator('#splash').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.nav').isHidden(), true, 'a narrow window starts with the menu closed');
  assert.equal(await page.locator('.slider').inputValue(), '0', 'mute is kept across a reload');
  await page.locator('.list .row').first().locator('.names').click();
  await page.locator('.player').waitFor();
  await page.locator('[aria-label="음소거 해제"]').click();
  assert.equal(await page.locator('.slider').inputValue(), '40', 'the volume is kept across a reload');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(evidence, 'web-ui-narrow.png') });
  log('PASS 480px: the menu starts closed and rows take the narrow layout');

  await page.setViewportSize({ width: 400, height: 728 });
  await page.reload({ waitUntil: 'load' });
  await page.locator('.none p', { hasText: '데스크톱 Chrome과 Edge' }).waitFor({ timeout: 10_000 });
  await page.locator('#splash').waitFor({ state: 'detached', timeout: 10_000 });
  log('PASS unsupported screen: the notice shows and the start screen leaves');

  await page.setViewportSize({ width: 1100, height: 728 });
  await page.addInitScript(() => { FileSystemHandle.prototype.queryPermission = async () => 'prompt'; });
  await page.reload({ waitUntil: 'load' });
  await page.locator('.nav-i', { hasText: '설정' }).click();
  await page.locator('.li').getByRole('button', { name: '다시 허용' }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(evidence, 'web-ui-settings-permission.png') });
  log('PASS settings offers 다시 허용 when the browser must ask for the folder again');
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  assert.deepEqual(outside, [], 'nothing leaves the machine');
  log('PASS no uncaught page errors');
  await writeFile(path.join(evidence, 'web-qa-rows.json'), JSON.stringify(persisted.map(({ embedding, ...row }) => ({ ...row, embedding: embedding.slice(0, 4) })), null, 2));
  await writeFile(path.join(evidence, 'web-qa-timing.json'), JSON.stringify({ run, reopened: { ms: reopened.ms, analysing: reopened.analysing } }, null, 2));
  log('PASS web QA');
} catch (error) {
  failed = true;
  log(`FAIL ${error?.stack ?? error}`);
  if (errors.length) log(`PAGE_ERRORS ${errors.join(' | ')}`);
} finally {
  await context?.close();
  await close(server);
  await close(relay);
  await rm(profile, { recursive: true, force: true });
  await rm(downloads, { recursive: true, force: true });
  log('CLEANUP browser closed, servers closed, temp profile removed');
  await writeFile(path.join(evidence, 'web-qa.log'), lines.join('\n') + '\n');
}
process.exit(failed ? 1 : 0);
