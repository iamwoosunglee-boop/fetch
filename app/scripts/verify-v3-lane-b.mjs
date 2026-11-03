// Hidden Electron proof for v3 lane B: a fresh profile connects web-demo/sounds and every analysed
// audio:sounds row carries 48 peaks, a pack name and addedAt. Also exercises audio:id-for-path and
// library:connect-drop through the real preload.
// Usage: PROTO1_HIDDEN=1 node scripts/verify-v3-lane-b.mjs [appDir]   (appDir defaults to this app)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

assert.equal(process.env.PROTO1_HIDDEN, '1', 'Hidden mode is required');
const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const appDir = path.resolve(process.argv[2] ?? here);
const sounds = path.join(here, 'web-demo/sounds');
const evidence = path.resolve(here, '../../.omo/evidence/v3-lane-b');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'proto1-lane-b-profile-'));
await fs.mkdir(evidence, { recursive: true });

const app = await _electron.launch({
  args: [appDir, `--user-data-dir=${profile}`],
  env: { ...process.env, PROTO1_HIDDEN: '1' },
});
try {
  await app.context().route('https://huggingface.co/**', async (route) => {
    const name = route.request().url().split('/resolve/c28f2883575e590e04d3146ff0713c2448d691ba/')[1];
    assert(name, 'Model revision must be pinned');
    await route.fulfill({
      path: path.resolve(here, '../_experiments/e4_browser/models/Xenova/clap-htsat-unfused', name),
      headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' },
    });
  });
  const page = await app.firstWindow();
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())));
  const started = Date.now();
  const progress = await page.evaluate((root) => new Promise((resolve, reject) => {
    const api = window.fetchApp.library;
    const timer = setTimeout(() => reject(new Error('Indexing timed out')), 900_000);
    const off = api.onProgress((p) => {
      if (p.status === 'completed' && p.remaining === 0) { clearTimeout(timer); off(); resolve(p); }
      if (p.status === 'stopped') { clearTimeout(timer); off(); reject(new Error(p.reason)); }
    });
    window.fetchApp.connections.connectFolder(root).catch(reject);
  }), sounds);
  const result = await page.evaluate(async (root) => {
    const rows = await window.fetchApp.nativeAudio.sounds();
    const first = rows[0];
    return {
      rows: rows.map(({ embedding, ...row }) => ({ ...row, hasEmbedding: Boolean(embedding) })),
      measurementGone: !('measurement' in window.fetchApp),
      pathForFile: typeof window.fetchApp.pathForFile,
      idForStored: await window.fetchApp.nativeAudio.idForPath(`${first.root}/${first.relativePath}`),
      firstId: first.id,
      idForUnknown: await window.fetchApp.nativeAudio.idForPath(`${root}/no-such-file.wav`),
      dropFile: await window.fetchApp.connections.connectPath(`${first.root}/${first.relativePath}`),
    };
  }, sounds);
  const analysed = result.rows.filter((row) => row.hasEmbedding);
  const summary = {
    seconds: Math.round((Date.now() - started) / 1000), progress,
    rows: result.rows.length, analysed: analysed.length,
    withPeaks48: analysed.filter((row) => row.peaks?.length === 48 && row.peaks.every((v) => v >= 0 && v <= 1)).length,
    withPackName: result.rows.filter((row) => typeof row.packName === 'string' && row.packName).length,
    withAddedAt: result.rows.filter((row) => Number.isFinite(row.addedAt) && row.addedAt > 0).length,
    withUsed: result.rows.filter((row) => 'used' in row).length,
    packNames: [...new Set(result.rows.map((row) => row.packName))],
    measurementGone: result.measurementGone, pathForFile: result.pathForFile,
    idForStoredMatches: result.idForStored === result.firstId, idForUnknown: result.idForUnknown,
    dropFileConnects: result.dropFile,
    sample: result.rows.slice(0, 2),
  };
  assert(summary.analysed > 0 && summary.analysed === summary.rows);
  assert.equal(summary.withPeaks48, summary.analysed);
  assert.equal(summary.withPackName, summary.rows);
  assert.equal(summary.withAddedAt, summary.rows);
  assert.equal(summary.withUsed, 0);
  assert(summary.measurementGone && summary.pathForFile === 'function');
  assert(summary.idForStoredMatches && summary.idForUnknown === null && summary.dropFileConnects === false);
  await fs.writeFile(path.join(evidence, 'electron-sounds.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`PASS ${summary.rows} rows, ${summary.withPeaks48} with 48 peaks, packs ${summary.packNames.join(', ')}`);
} finally {
  await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
