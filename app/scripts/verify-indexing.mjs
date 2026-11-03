import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';

assert.equal(process.env.PROTO1_HIDDEN, '1', 'Hidden mode is required');
const require = createRequire(import.meta.url);
const { Store } = require('../dist/electron/main/store.js');
const { scanLibrary } = require('../dist/electron/main/scan.js');
const root = process.cwd();
const source = path.resolve('../_experiments/kr1_library');
const qa = await fs.mkdtemp(path.join(root, '.omo/indexing-qa-'));
const profile = path.join(qa, 'profile');
const drive = path.join(qa, 'drive');
let app;

async function snapshot(directory) {
  const rows = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const info = await fs.stat(file);
    rows.push([file, info.size, info.mtimeMs]);
    if (entry.isDirectory()) rows.push(...await snapshot(file));
  }
  return rows;
}

async function launch() {
  app = await _electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    env: { ...process.env, PROTO1_HIDDEN: '1' },
  });
  // Reuse exactly the pinned local model artifacts, never substitute vectors or inference.
  await app.context().route('https://huggingface.co/**', async (route) => {
    const name = route.request().url().split('/resolve/c28f2883575e590e04d3146ff0713c2448d691ba/')[1];
    assert(name, 'Model revision must be pinned');
    await route.fulfill({
      path: path.resolve('../_experiments/e4_browser/models/Xenova/clap-htsat-unfused', name),
      headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' },
    });
  });
  const page = await app.firstWindow();
  await page.evaluate(() => {
    if (!window.fetchApp?.library) throw new Error('Library IPC is missing');
  });
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())));
  return page;
}

async function until(page, target, action) {
  return page.evaluate(async ({ target, action }) => {
    const api = window.fetchApp.library;
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('Indexing event timed out')); }, 180_000);
      const accept = (progress) => {
        const matches = target.status ? progress.status === target.status : progress.completed >= target.completed;
        if (matches || (progress.status === 'stopped' && target.status !== 'stopped')) {
          clearTimeout(timer);
          unsubscribe();
          if (!matches) reject(new Error(progress.reason));
          else resolve(progress);
        }
      };
      unsubscribe = api.onProgress(accept);
      if (action === 'resume') api.resume().then(accept, reject);
      else api.progress().then(accept, reject);
    });
  }, { target, action });
}

try {
  const before = await snapshot(source);
  const scan = await scanLibrary(source);
  assert.equal(scan.status, 'completed');
  const selected = scan.items.filter((item) => item.embeddingEligible).slice(0, 100);
  assert.equal(selected.length, 100);
  const store = new Store(profile);
  let page = await launch();
  store.saveItems(selected.map((item) => ({
    id: item.id, fullSha256: item.sha256, edgeSha256: item.edgeSha256, size: item.size,
    mtimeMs: item.paths[0].mtimeMs,
    paths: [{ folderId: source, path: item.paths[0].path }],
  })));
  store.saveFolders([{ root: source }]);
  console.log(`PASS scanned ${scan.fileCount} files; selected 100 unique source sounds`);

  const partial = await until(page, { completed: 25 }, 'resume');
  assert(partial.completed >= 25 && partial.completed < 100);
  const partialItems = await page.evaluate(() => window.fetchApp.library.items());
  assert(partialItems.filter((item) => item.vector).length >= 25);
  assert(partialItems.some((item) => !item.vector));
  const beforeExit = await page.evaluate(() => window.fetchApp.library.progress());
  assert(beforeExit.completed < 100);
  // Exit the app during active processing, rather than politely draining the queue.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = undefined;
  const reopened = new Store(profile);
  const saved = selected.filter((item) => reopened.getEmbedding(item.id)).length;
  assert(saved >= 25 && saved < 100);
  console.log(`PASS interrupted while running: persisted=${saved}, remaining=${100 - saved}; finished vectors available via IPC`);

  page = await launch();
  const completed = await until(page, { status: 'completed' });
  assert.equal(completed.completed, 100);
  assert.equal(completed.processed, 100 - saved);
  assert.equal(completed.failed, 0);
  const rows = (await fs.readFile(path.join(profile, 'embeddings.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 100);
  assert.equal(new Set(rows.map((row) => row.id)).size, 100);
  assert(rows.every((row) => row.vector.length === 512 && row.vector.every(Number.isFinite)));
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())));
  console.log(`PASS reopened app: processed=${completed.processed}; 100 unique persisted vectors; duplicates=0; all windows hidden`);
  await app.close();
  app = undefined;

  // Simulate a disconnected drive by removing only our app-data symlink.
  // The real library directory is never renamed, removed or written.
  await fs.symlink(source, drive, 'dir');
  const failureItems = selected.slice(0, 6).map((item, i) => ({
    id: `failure-${i}`, fullSha256: item.sha256, size: item.size,
    paths: [{ folderId: drive, path: path.join(drive, path.relative(source, item.paths[0].path)) }],
  }));
  const failureStore = new Store(profile);
  page = await launch();
  failureStore.saveItems(failureItems);
  failureStore.saveFolders([{ root: drive }]);
  await page.exposeFunction('disconnectDrive', () => fs.unlink(drive));
  const stopped = await page.evaluate(() => {
    const api = window.fetchApp.library;
    return new Promise((resolve, reject) => {
      let disconnected = false;
      let off = () => {};
      const timer = setTimeout(() => { off(); reject(new Error('Drive disappearance event timed out')); }, 180_000);
      off = api.onProgress((progress) => {
        if (progress.completed >= 1 && !disconnected) {
          disconnected = true;
          window.disconnectDrive().catch(reject);
        }
        if (progress.status === 'stopped') {
          clearTimeout(timer);
          off();
          resolve(progress);
        }
      });
      api.resume().then((progress) => {
        if (progress.completed >= 1 && !disconnected) {
          disconnected = true;
          window.disconnectDrive().catch(reject);
        }
      }, reject);
    });
  });
  assert(stopped.completed >= 1 && stopped.completed < 6);
  assert.equal(stopped.failed, 0);
  assert(stopped.reason);
  const retained = new Store(profile);
  assert.equal(failureItems.filter((item) => retained.getEmbedding(item.id)).length, stopped.completed);
  const connections = await page.evaluate(() => window.fetchApp.connections.getFolders());
  assert.equal(connections[0].status, 'stopped');
  assert.equal(connections[0].completed, stopped.completed);
  assert(connections[0].reason);
  console.log(`PASS drive disappeared: stopped=${stopped.status}; retained=${stopped.completed}; remaining=${stopped.remaining}; reason=${stopped.reason}`);
  await fs.symlink(source, drive, 'dir');
  const recovered = await until(page, { status: 'completed' }, 'resume');
  assert.equal(recovered.completed, 6);
  assert.equal(recovered.processed, 6 - stopped.completed);
  console.log(`PASS drive restored: resumed only ${recovered.processed} remaining sounds`);

  assert.deepEqual(await snapshot(source), before);
  for (const item of selected) {
    const digest = createHash('sha256').update(await fs.readFile(item.paths[0].path)).digest('hex');
    assert.equal(digest, item.sha256);
  }
  console.log('PASS source library file list, sizes and modification times unchanged; 100 SHA-256 hashes unchanged');
} finally {
  if (app) await app.close();
  await fs.rm(qa, { recursive: true, force: true });
  console.log('CLEANUP Electron closed; isolated app-data profile and simulated-drive symlink removed');
}
