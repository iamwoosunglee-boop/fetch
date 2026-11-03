import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Runs every UCS sample through the app's q8 audio path and the app's classify rules.
// Reads the samples only; results go to .omo/evidence.
const samples = path.resolve('../_experiments/ucs_samples');
const modelFiles = path.resolve('../_experiments/e4_browser/models/Xenova/clap-htsat-unfused');
const executablePath = process.env.CHROMIUM_PATH ?? path.resolve('../_experiments/e4_browser/browsers/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium');
const output = path.resolve('.omo/evidence/task-17-card-measure.json');

function checkMemory() {
  const report = execFileSync('memory_pressure', [], { encoding: 'utf8' });
  const free = Number(report.match(/System-wide memory free percentage:\s*(\d+)%/)?.[1]);
  assert(Number.isFinite(free) && free >= 30, `Memory free ${free}%; stopped before inference.`);
  return free;
}

const files = (await readdir(samples, { recursive: true })).filter((name) => name.endsWith('.wav')).sort();
console.log(`MEMORY_FREE ${checkMemory()}% files=${files.length}`);
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const headers = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
  await context.route('https://huggingface.co/**', async (route) => {
    const name = route.request().url().split('/resolve/c28f2883575e590e04d3146ff0713c2448d691ba/')[1];
    try {
      await route.fulfill({ body: await readFile(path.join(modelFiles, name)), headers });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await route.continue();
    }
  });
  await context.route('**/ucs-sample/**', async (route) => {
    const index = Number(route.request().url().split('/ucs-sample/')[1]);
    await route.fulfill({ body: await readFile(path.join(samples, files[index])), headers });
  });
  await page.goto(`${server.resolvedUrls.local[0]}src/model/verify.html`);
  await page.evaluate(async () => {
    window.model = await import('/src/model/index.ts');
    window.classify = await import('/src/core/classify/index.ts');
    window.vectors = [];
  });
  for (const [index] of files.entries()) {
    if (index % 25 === 0) { checkMemory(); console.log(`AUDIO ${index}/${files.length}`); }
    await page.evaluate(async (index) => {
      const bytes = await (await fetch(`/ucs-sample/${index}`)).arrayBuffer();
      window.vectors[index] = await window.model.embedAudio(bytes);
    }, index);
  }
  const report = await page.evaluate((files) => {
    const sounds = files.map((relativePath, index) => ({
      id: String(index), folder: 'samples', relativePath, fullHash: String(index), embedding: window.vectors[index],
    }));
    const named = window.classify.classifyLibrary(sounds, {});
    const count = (overview) => Object.fromEntries(['unclassified', 'name', 'human', 'card']
      .map((state) => [state, overview.sounds.filter((sound) => sound.state === state).length]));
    // The same audio without its code shows what the no-code path would do with it.
    const nameless = window.classify.classifyLibrary(sounds.map((sound) => ({ ...sound, relativePath: `${sound.id.replace(/\d/g, (digit) => 'abcdefghij'[digit])}.wav` })), {});
    return {
      total: sounds.length,
      ucsNames: files.filter((name) => window.classify.readUcsName(name)).length,
      withNames: { states: count(named), cards: named.cards.length, cardFiles: named.cards.map((card) => ({
        file: files[Number(card.soundIds[0])], name: card.nameCategory, candidates: card.candidates,
      })) },
      withoutNames: { states: count(nameless), cards: nameless.cards.length },
    };
  }, files);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(`UCS_NAMES ${report.ucsNames}/${report.total}`);
  console.log(`STATES ${JSON.stringify(report.withNames.states)} CARDS ${report.withNames.cards}`);
  console.log(`WITHOUT_NAMES ${JSON.stringify(report.withoutNames.states)}`);
} finally {
  await browser?.close();
  await server.close();
}
