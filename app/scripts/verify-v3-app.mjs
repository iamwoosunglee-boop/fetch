// C2-C4 on the built Mac app in a hidden window with a temp profile and a fake relay:
// library list (rows, filters, sort, search box), chat (answer line, 3 results, more, no repeats),
// drag preparation (logged instead of a real OS drag) and dropping a library file on the chat input.
// Usage: npm run build && PROTO1_HIDDEN=1 nice -n 15 node scripts/verify-v3-app.mjs
import assert from 'node:assert/strict';
import { watch } from 'node:fs/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connectAndAnalyse, demoSounds, evidenceDir, launchHidden, startFakeRelay } from './v3-harness.mjs';

const out = await evidenceDir('v3-app');
const log = [];
const note = (line) => { log.push(line); console.log(line); };
const relay = await startFakeRelay((input) => {
  if (/더 짧게/.test(input.text)) {
    return { english_queries: [], name_keywords: [], min_duration_seconds: null, max_duration_seconds: null, explanation: '더 짧은 소리로 좁혔어요.' };
  }
  return { english_queries: ['a sci-fi laser gun shot'], name_keywords: ['laser'], min_duration_seconds: null, max_duration_seconds: null, explanation: '레이저 발사 소리를 찾았어요.' };
});
const { page, profile, close } = await launchHidden({ relayUrl: relay.url, testDrag: true, seeded: true });
const count = async () => Number((await page.locator('.head .count .num').first().innerText()).replace(/,/g, ''));
const rowNames = () => page.locator('.list .row .fname').allInnerTexts();
try {
  await page.evaluate(() => {
    window.qaStrip = [];
    new MutationObserver(() => window.qaStrip.push(document.querySelector('.strip').textContent)).observe(document.querySelector('.strip'), { childList: true });
  });
  const progress = await connectAndAnalyse(page, demoSounds);
  const stripText = (await page.evaluate(() => window.qaStrip)).find(Boolean) ?? '';
  // The strip also carries the text model download that started at launch.
  await page.waitForFunction(() => document.querySelector('.strip')?.hidden === true, null, { timeout: 600_000 });
  note(`PASS analysis ${progress.completed}/${progress.total}; strip while running: ${stripText.replace(/\s+/g, ' ').trim()}`);
  assert(/소리 분석 중|분석 자료 다운로드 중|폴더 확인 중/.test(stripText), 'the bottom strip shows progress while analysing');
  await page.waitForFunction(() => Number(document.querySelector('.head .count .num')?.textContent?.replace(/,/g, '')) === 300, null, { timeout: 30_000 });
  const rows = await page.evaluate(async () => {
    const sounds = await window.fetchApp.nativeAudio.sounds();
    const unique = new Map(sounds.map((sound) => [sound.fullHash, sound]));
    return [...unique.values()].map(({ relativePath, packName, duration, peaks }) => ({ relativePath, packName, duration, peaks: peaks?.length ?? 0 }));
  });
  assert.equal(rows.length, 300);

  const first = page.locator('.list .row').first();
  const tile = await first.locator('.tile').getAttribute('aria-label');
  assert.equal(await first.locator('.tile img').count(), 1, 'the pack cover in the tile');
  assert.equal(await first.locator('.wave rect').count(), 80, 'a list 860 wide or more has 80 bars');
  const tallest = await first.locator('.wave rect').evaluateAll((bars) => Math.max(...bars.map((bar) => Number(bar.getAttribute('height')))));
  assert(tallest > 5, 'waveform comes from stored peaks, not a flat line');
  assert.match(await first.locator('.dur').innerText(), /^\d+\.\d{2}초$/);
  for (const selector of ['.heart', '.mb']) assert.equal(await first.locator(selector).count(), 1, `row has ${selector}`);
  assert.equal(await first.locator('.grip').count(), 0, 'no handle');
  assert.equal(await first.getAttribute('draggable'), 'true', 'the whole row drags');
  await page.screenshot({ path: path.join(out, 'c2-list.png') });
  note(`PASS rows: cover tile of ${tile}, 80 bars (tallest ${tallest.toFixed(1)}), duration, heart, menu, no handle`);

  const expect = (predicate) => rows.filter(predicate).length;
  await page.locator('.filters .chip').nth(0).click();
  await page.locator('.pop button[aria-label="kenney-sci-fi-sounds"]').click();
  assert.equal(await count(), expect((row) => row.packName === 'kenney-sci-fi-sounds'), 'pack filter');
  note(`PASS pack filter kenney-sci-fi-sounds -> ${await count()}`);
  await page.locator('.filters .chip').nth(0).click();
  await page.locator('.pop button[aria-label="kenney-sci-fi-sounds"]').click();
  assert.equal(await count(), 300);

  await page.locator('.filters .chip').nth(2).click();
  await page.locator('.pop button', { hasText: '2초 이상' }).click();
  assert.equal(await count(), expect((row) => row.duration >= 2), 'length filter');
  note(`PASS length filter 2초 이상 -> ${await count()}`);
  await page.locator('.filters .chip').nth(2).click();
  await page.locator('.pop button', { hasText: '2초 이상' }).click();

  await page.locator('.filters .chip').nth(1).click();
  const kindRow = page.locator('.pop button').first();
  const kindCount = Number(await kindRow.locator('.num').innerText());
  await kindRow.click();
  assert.equal(await count(), kindCount, 'kind filter count matches its menu count');
  note(`PASS kind filter -> ${kindCount}`);
  await page.locator('.filters .chip').nth(1).click();
  await page.locator('.pop button').first().click();

  await page.locator('.sort').click();
  await page.locator('.pop button', { hasText: '길이순' }).click();
  const shortest = Math.min(...rows.map((row) => row.duration));
  await page.waitForFunction((text) => document.querySelector('.list .row .dur')?.textContent === text, `${shortest.toFixed(2)}초`, { timeout: 15_000 });
  note('PASS sort 길이순');
  await page.locator('.sort').click();
  await page.locator('.pop button', { hasText: '팩순' }).click();

  const liked = await page.locator('.list .row .fname').first().innerText();
  await page.locator('.list .row').first().hover();
  await page.locator('.list .row .heart').first().click();
  await page.locator('.filters .chip', { hasText: '즐겨찾기' }).click();
  assert.equal(await count(), 1, 'favorites filter');
  assert.deepEqual(await rowNames(), [liked]);
  const saved = await page.evaluate(() => window.fetchApp.collections.load());
  assert.equal(saved.favorites?.length, 1, 'favorite is saved');
  await page.locator('.filters .chip', { hasText: '즐겨찾기' }).click();
  note(`PASS favorite ${liked} saved and filtered`);

  const before = relay.calls.length;
  await page.getByRole('searchbox', { name: '파일 이름 검색' }).fill('laser');
  const names = await rowNames();
  assert(names.length > 0 && names.every((name) => /laser/i.test(name)), 'search box keeps only matching names');
  assert.equal(relay.calls.length, before, 'the search box never calls the relay');
  await page.screenshot({ path: path.join(out, 'c2-search.png') });
  note(`PASS search box laser -> ${await count()} rows, relay calls ${relay.calls.length - before}`);
  await page.getByRole('searchbox', { name: '파일 이름 검색' }).fill('');

  await page.locator('.chatbtn').click();
  await page.locator('.compose-input').fill('레이저 발사 소리 찾아줘');
  await page.locator('.compose-input').press('Enter');
  const answer = page.locator('.ans').last();
  await answer.locator('.say').first().filter({ hasText: '3개를 가져왔어요.' }).waitFor({ timeout: 120_000 });
  await page.waitForFunction(() => document.querySelectorAll('.ans:last-of-type .crow').length === 3 && !document.querySelector('.ans .dots'), null, { timeout: 60_000 });
  const firstIds = await answer.locator('.crow').evaluateAll((items) => items.map((item) => item.dataset.id));
  assert.equal(firstIds.length, 3, '3 results');
  await answer.getByRole('button', { name: '더 보기' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ans:last-of-type .crow').length === 6, null, { timeout: 30_000 });
  const moreIds = await answer.locator('.crow').evaluateAll((items) => items.map((item) => item.dataset.id));
  assert.equal(new Set(moreIds).size, 6, 'more adds 3 unseen sounds');
  await page.screenshot({ path: path.join(out, 'c3-chat.png') });
  await page.locator('.compose-input').fill('더 짧게');
  await page.locator('.compose-input').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.ans').length === 2 && !document.querySelector('.ans .dots'), null, { timeout: 60_000 });
  const allIds = await page.locator('.ans .crow').evaluateAll((items) => items.map((item) => item.dataset.id));
  assert.equal(new Set(allIds).size, allIds.length, 'no sound repeats in one tab');
  assert.equal(relay.calls.length - before, 2, 'two chat requests reached the relay');
  assert.equal(relay.calls.at(-1).previous_plan?.result_count, undefined, 'result_count is never inherited');
  await page.screenshot({ path: path.join(out, 'c3-chat-followup.png') });
  note(`PASS chat: line, 3 results, more -> 6 unseen, follow-up keeps ${allIds.length} unique, relay calls 2`);

  const oggRow = page.locator('.list .row', { hasText: '.ogg' }).first();
  const oggName = await oggRow.locator('.fname').innerText();
  await oggRow.hover();
  await page.waitForFunction((name) => {
    const row = [...document.querySelectorAll('.list .row')].find((item) => item.querySelector('.fname')?.textContent === name);
    return row && !row.classList.contains('wait');
  }, oggName, { timeout: 30_000 });
  const logFile = path.join(profile, 'drag-test.jsonl');
  const changes = watch(profile, { signal: AbortSignal.timeout(30_000) });
  const recorded = (async () => {
    for await (const event of changes) {
      if (event.filename !== 'drag-test.jsonl') continue;
      const text = await fs.readFile(logFile, 'utf8');
      if (text.endsWith('\n')) return JSON.parse(text.trim().split('\n').at(-1));
    }
  })();
  await oggRow.dispatchEvent('dragstart');
  const entry = await recorded;
  assert(entry && entry.file.endsWith('.wav') && entry.file.includes('wav-copies'), 'an OGG row drags its WAV copy');
  note(`PASS drag prepared ${oggName} -> ${path.basename(entry.file)} (logged, no OS drag)`);

  const target = path.join(demoSounds, rows.find((row) => row.relativePath.endsWith('laserLarge_000.ogg')).relativePath);
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'qa-file'; input.hidden = true; document.body.append(input); });
  await page.setInputFiles('#qa-file', target);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(document.querySelector('#qa-file').files[0]);
    document.querySelector('.compose').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await page.locator('.attach .fname', { hasText: 'laserLarge_000.ogg' }).waitFor({ timeout: 30_000 });
  await page.locator('.compose-input').press('Enter');
  await page.locator('.pinned .refchip', { hasText: 'laserLarge_000.ogg' }).waitFor({ timeout: 30_000 });
  await page.locator('.ans .say', { hasText: /넣어 주신 소리와 비슷한 \d+개를 (다른 팩에서 )?(먼저 )?가져왔어요\./ }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(out, 'c4-reference.png') });
  note('PASS library file dropped on chat became the pinned reference (soundIdForFile)');

  await page.locator('.chatbtn').click();
  await page.screenshot({ path: path.join(out, 'nav.png') });
  await page.locator('.nav-i', { hasText: '팩' }).click();
  await page.screenshot({ path: path.join(out, 'packs.png') });
  await page.locator('.nav-i', { hasText: '설정' }).click();
  await page.screenshot({ path: path.join(out, 'settings.png') });
  await page.locator('.nav-i', { hasText: '모든 소리' }).click();
  note('PASS nav, packs, settings screens rendered');

  const playRow = page.locator('.list .row').nth(1);
  const playName = await playRow.locator('.fname').innerText();
  await playRow.locator('.play').click();
  await page.locator('.player .fname', { hasText: playName }).waitFor({ timeout: 10_000 });
  note(`PASS playback from the row button: ${playName} in the player bar`);
  await fs.writeFile(path.join(out, 'verify-v3-app.log'), `${log.join('\n')}\n`);
  console.log('PASS verify-v3-app');
} finally {
  await close();
  await relay.close();
}
