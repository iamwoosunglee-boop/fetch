// C1: the first launch on an empty profile shows the app frame with the menu bar open and a folder drop zone.
// Search works, the filters and the chat button are off, no sound count shows, and typing never shows a "no results" line.
// Usage: PROTO1_HIDDEN=1 nice -n 15 node scripts/verify-first-run.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { evidenceDir, launchHidden, startFakeRelay } from './v3-harness.mjs';

const out = await evidenceDir('v3-c1');
const relay = await startFakeRelay(() => ({ status: 500, body: { error: 'UNEXPECTED' } }));
const { page, close } = await launchHidden({ relayUrl: relay.url, holdTextModel: true });
try {
  const zone = page.locator('.dropzone');
  await zone.waitFor({ state: 'visible' });
  await page.locator('#splash').waitFor({ state: 'detached' });
  assert.equal((await zone.innerText()).includes('소리 폴더를 여기에 끌어다 놓거나 선택하세요'), true);
  assert.equal(await zone.getByRole('button', { name: '폴더 선택하기', exact: true }).isVisible(), true);
  assert.equal(await page.locator('.top').isVisible(), true, 'top bar is visible');
  assert.equal(await page.locator('.filters').isVisible(), true, 'filter row is visible');
  assert.equal(await page.locator('.nav').isVisible(), true, 'a wide window starts with the menu bar open');
  assert.equal(await page.locator('.nav-i').last().innerText(), '설정', 'settings is the last menu item');
  assert.equal(await page.locator('.nav-i', { hasText: '라이브러리 폴더' }).count(), 0, 'the library folders item is gone');
  assert.equal(await page.locator('.head .count').count(), 0, 'no sound count before a folder exists');
  assert.equal(await page.locator('.chatbtn').isDisabled(), true, 'chat stays off without sounds');
  const search = page.getByRole('searchbox', { name: '파일 이름 검색' });
  assert.equal(await search.isEnabled(), true, 'search box works without a folder');
  assert.equal(await page.locator('.filters.dim').count(), 1, 'the filters are dim before a folder exists');
  const chip = await page.locator('.filters .chip').first().boundingBox();
  await page.mouse.click(chip.x + chip.width / 2, chip.y + chip.height / 2);
  assert.equal(await page.locator('.pop').count(), 0, 'the pack filter stays closed');
  await page.screenshot({ path: path.join(out, 'first-run.png') });
  await search.fill('laser');
  assert.equal(await zone.isVisible(), true, 'the drop zone stays after typing');
  const text = await page.locator('body').innerText();
  for (const phrase of ['결과 없음', '소리가 없습니다', '검색어를 바꾸']) assert.equal(text.includes(phrase), false, `no "${phrase}" before a folder exists`);
  await page.screenshot({ path: path.join(out, 'first-run-typed.png') });
  assert.equal(relay.calls.length, 0, 'nothing reaches the relay');
  console.log(`PASS first run: frame, open menu, drop zone, chat and filters off, no count, search usable without a folder; evidence ${path.relative(process.cwd(), out)}`);
} finally {
  await close();
  await relay.close();
}
