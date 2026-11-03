// The hands-on review of the polish: each check walks one finding with real clicks and keys.
// allow: SIZE_OK - One journey through one page: the checks share its helpers and hand its state to each other.
// Numbers follow the review's list. Each check leaves all sounds on screen, no filters, menu open, panel closed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { answerPlan } from './polish2-chat.mjs';
import { connectAndAnalyse } from './v3-harness.mjs';

const NEW_SOUNDS = 24;

/** A short WAV of its own pitch, so analysis sees a sound no other file has. */
function toneWav(frequency) {
  const rate = 22_050;
  const samples = Math.floor(rate * 0.4);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + samples * 2, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(samples * 2, 40);
  const body = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) body.writeInt16LE(Math.round(12_000 * Math.sin((2 * Math.PI * frequency * index) / rate)), index * 2);
  return Buffer.concat([head, body]);
}

export function reviewChecks({ page, pass, shot, resize, setReply, away, pick }) {
  const search = page.getByRole('searchbox', { name: '파일 이름 검색' });
  const compose = page.locator('.compose-input');
  const chatButton = page.locator('.chatbtn');
  const menuButton = page.locator('.top .ib').first();
  const back = page.locator('[aria-label="뒤로"]');
  const forward = page.locator('[aria-label="앞으로"]');
  const rows = page.locator('.list .row');
  const title = page.locator('.head h1');
  const count = page.locator('.head .count');
  const list = page.locator('.list');
  const player = page.locator('.player');
  const toggleButton = page.locator('.player .pp');
  const menuItem = (name) => page.locator('.nav-i', { hasText: name });
  const playing = () => page.locator('.player .pp[aria-label="일시 정지"]').waitFor();
  const paused = () => page.locator('.player .pp[aria-label="재생"]').waitFor();
  const keysOnList = () => page.evaluate(() => document.activeElement?.classList.contains('list'));
  const selected = () => page.locator('.list .row.sel').getAttribute('data-id');
  const inPlayer = (name) => page.waitForFunction((text) => document.querySelector('.player .fname')?.textContent === text, name);
  const quiet = () => page.waitForFunction(() => !document.querySelector('.ans .dots'), null, { timeout: 30_000 });
  const stopSound = async () => {
    if (await player.isVisible() && await toggleButton.getAttribute('aria-label') === '일시 정지') {
      await page.keyboard.press('Escape');
      await paused();
    }
  };
  const collection = async (name) => {
    await page.locator('[aria-label="새 모음"]').click();
    await page.locator('.nav-new').fill(name);
    await page.locator('.nav-new').press('Enter');
    await page.locator('.nav-c', { hasText: name }).waitFor();
  };
  const menuTexts = () => page.locator('.menu:not(.sub) > button > span:nth-child(2)').allInnerTexts();
  const addToCollection = async (row, name) => {
    await row.locator('.mb').click();
    await page.getByRole('menuitem', { name: '모음에 추가' }).click();
    await page.locator('.menu.sub button', { hasText: name }).click();
  };

  return {
    /** Findings 10 and 14 need a page with nothing played yet, so they run first. */
    async startFocus() {
      assert.equal(await keysOnList(), true, 'the list holds the keys at launch');
      assert.equal(await page.locator('.search').evaluate((box) => getComputedStyle(box).outlineStyle), 'none', 'no amber ring on launch');
      await page.keyboard.press('Space');
      assert.equal(await search.inputValue(), '', 'Space types nothing');
      assert.equal(await player.isVisible(), false, 'nothing to play yet');
      pass('10: the list holds the keys at launch, no ring on the search box, Space types nothing');
    },

    async firstPlayReveal() {
      const spot = await list.evaluate((scroller) => {
        const bottom = scroller.getBoundingClientRect().bottom;
        const row = [...scroller.querySelectorAll('.row')].find((item) => { const box = item.getBoundingClientRect(); return box.top < bottom - 8 && box.bottom > bottom - 61; });
        const box = row.getBoundingClientRect();
        return { x: box.left + 300, y: Math.min(box.top + 26, bottom - 4) };
      });
      await page.mouse.click(spot.x, spot.y);
      await player.waitFor();
      const fit = await list.evaluate((scroller) => ({ bottom: scroller.getBoundingClientRect().bottom, row: scroller.querySelector('.row.sel').getBoundingClientRect().bottom }));
      assert(fit.row <= fit.bottom + 0.5, `the clicked row stays in view above the player: ${JSON.stringify(fit)}`);
      await stopSound();
      await list.evaluate((scroller) => { scroller.scrollTop = 0; });
      pass('14: the row clicked at the window edge stays in view when the player first appears');
    },

    async keysAfterMouse() {
      const downMoves = async (what) => {
        const before = await selected();
        await page.keyboard.press('ArrowDown');
        assert.notEqual(await selected(), before, `${what}: the down key moves the selection`);
        await stopSound();
      };
      await rows.nth(1).locator('.names').click();
      await stopSound();

      await menuItem('즐겨찾기').click();
      await menuItem('팩').click();
      await back.click();
      assert.equal(await title.innerText(), '즐겨찾기');
      await page.keyboard.press('Space');
      assert.equal(await title.innerText(), '즐겨찾기', 'Space does not press 뒤로 again');
      await back.click();
      await rows.first().waitFor();
      await downMoves('뒤로');

      const names = await page.locator('.list .row .fname').allInnerTexts();
      await rows.nth(2).locator('.names').click();
      await playing();
      await page.locator('.player [aria-label="다음"]').click();
      await inPlayer(names[3]);
      await page.keyboard.press('Space');
      await paused();
      assert.equal(await page.locator('.player .fname').innerText(), names[3], 'Space does not press 다음 again');
      await page.keyboard.press('ArrowUp');
      await stopSound();

      const slider = page.locator('.slider');
      const box = await slider.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const level = await slider.inputValue();
      assert.notEqual(level, '100', 'the click moved the slider');
      assert.equal(await keysOnList(), true, 'the slider hands the keys back to the list');
      await downMoves('슬라이더');
      assert.equal(await slider.inputValue(), level, 'the down key leaves the volume');

      await menuButton.click();
      await menuButton.click();
      await downMoves('메뉴 버튼');
      await menuItem('모든 소리').click();
      await downMoves('메뉴 항목');

      const head = await title.boundingBox();
      await page.mouse.click(head.x + 10, head.y + 10);
      await downMoves('제목');
      await page.locator('.player .bigwave-cell').click();
      await playing();
      await downMoves('재생 막대 파형');

      await menuButton.focus();
      await page.keyboard.press('Tab');
      assert.deepEqual(await page.evaluate(() => { const element = document.activeElement; return [Boolean(element.closest('.top')), getComputedStyle(element).outlineStyle]; }), [true, 'solid'], 'Tab still walks the top bar, with its ring');
      await rows.first().locator('.names').click();
      await stopSound();
      await list.evaluate((scroller) => { scroller.scrollTop = 0; });
      pass('1: after clicks on 뒤로, 다음, the slider, the menu, a heading and the wave, arrows and Space act on the list; Tab still works');
    },

    async packLink() {
      const row = rows.first();
      const link = row.locator('button.pack');
      const text = await link.evaluate((button) => { const range = document.createRange(); range.selectNodeContents(button); return range.getBoundingClientRect().width; });
      assert((await link.boundingBox()).width <= Math.ceil(text) + 1, 'the pack link is as wide as its text');
      const names = await row.locator('.names').boundingBox();
      const name = await row.locator('.fname').innerText();
      await page.mouse.click(names.x + names.width - 12, names.y + names.height - 6);
      await inPlayer(name);
      assert.equal(await title.innerText(), '모든 소리', 'a click right of the text plays and stays');
      await stopSound();
      const inBar = await page.locator('.player button.pack').evaluate((button) => { const range = document.createRange(); range.selectNodeContents(button); return [button.getBoundingClientRect().width, range.getBoundingClientRect().width]; });
      assert(inBar[0] <= Math.ceil(inBar[1]) + 1, `the player's pack link too: ${inBar}`);
      await away();
      pass('2: the pack link is as wide as its text in rows and in the player; a click beside it plays the sound');
    },

    async listHolds() {
      // The folder's name decides where its pack sorts, and this one sorts above every demo pack.
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aaa-new-sounds-'));
      await Promise.all(Array.from({ length: NEW_SOUNDS }, (_, index) => fs.writeFile(path.join(base, `aaa_${String(index).padStart(2, '0')}.wav`), toneWav(220 + index * 17))));
      const held = page.locator('.list .row[style*="top:1040px"]');
      await list.evaluate((scroller) => { scroller.scrollTop = 1040; });
      await held.waitFor();
      const name = await held.locator('.fname').innerText();
      const spot = await held.evaluate((row) => row.getBoundingClientRect().top);
      await connectAndAnalyse(page, base, 60_000);
      await page.waitForFunction((total) => document.querySelector('.head .count .total')?.textContent === total, String(300 + NEW_SOUNDS));
      const row = page.locator('.list .row', { hasText: name });
      await row.waitFor();
      assert.equal(await row.evaluate((item) => item.getBoundingClientRect().top), spot, 'the first visible row stays where it was');
      assert.equal(await list.evaluate((scroller) => scroller.scrollTop), 1040 + NEW_SOUNDS * 52, 'the new rows went above it');
      await page.evaluate((root) => window.fetchApp.connections.removeFolder(root), base);
      await page.waitForFunction(() => document.querySelector('.head .count .total')?.textContent === '300');
      await list.evaluate((scroller) => { scroller.scrollTop = 0; });
      pass(`3: ${NEW_SOUNDS} new sounds sorted above the view leave the first visible row where it was`);
    },

    async newCollection() {
      const row = rows.nth(2);
      const name = await row.locator('.fname').innerText();
      await row.locator('.mb').click();
      await page.getByRole('menuitem', { name: '모음에 추가' }).click();
      await page.locator('.menu.sub button', { hasText: '새 모음' }).click();
      await page.locator('.nav-new').fill('줄 메뉴 모음');
      await page.keyboard.press('Enter');
      await page.locator('.nav-c', { hasText: '줄 메뉴 모음' }).waitFor();
      assert.equal(await keysOnList(), true, 'the keys come back to the list');
      await page.locator('.nav-c', { hasText: '줄 메뉴 모음' }).click();
      assert.equal(await count.innerText(), '소리 1개', 'the sound went in');
      assert.equal(await rows.first().locator('.fname').innerText(), name);
      await menuItem('모든 소리').click();
      pass('4: a new collection from the row menu holds the sound, and the keys go back to the list');
    },

    async searchLeaves() {
      for (const [screen, ready] of [['팩', '.packs'], ['설정', '.set']]) {
        await menuItem(screen).click();
        await page.locator(ready).waitFor();
        await search.click();
        await page.keyboard.type('door', { delay: 20 });
        await title.getByText('"door" 검색 결과').waitFor();
        assert((await rows.count()) > 0, `${screen}: the results show`);
        assert.equal(await menuItem('모든 소리').getAttribute('aria-current'), 'page', `${screen}: the menu follows`);
        await search.press('Enter');
        await back.click();
        await page.locator(ready).waitFor();
        assert.equal(await search.inputValue(), '', `${screen}: one step back undoes the word`);
        await forward.click();
        await title.getByText('"door" 검색 결과').waitFor();
        await back.click();
        await page.locator(ready).waitFor();
      }
      await menuItem('모든 소리').click();
      pass('5: typing on packs or settings goes to all sounds, as one step back');
    },

    async coveredPanel() {
      await resize(720);
      await page.locator('.nav').waitFor({ state: 'hidden' });
      const chat = page.locator('.chat');
      await chatButton.click();
      await chat.waitFor();
      await menuButton.click();
      await menuItem('즐겨찾기').click();
      await chat.waitFor({ state: 'hidden' });
      assert.equal(await title.innerText(), '즐겨찾기', 'the new screen is what shows');
      await menuButton.click();
      await menuItem('모든 소리').click();
      setReply(async () => answerPlan);
      await chatButton.click();
      await compose.fill('"laser"');
      await compose.press('Enter');
      await page.locator('.ans .crow').first().waitFor();
      await quiet();
      await page.locator('.ans .crow button.pack').first().click();
      await page.locator('.packtop').waitFor();
      await chat.waitFor({ state: 'hidden' });
      await resize(1100);
      await menuButton.click();
      await menuItem('모든 소리').click();
      pass('6: a menu item or a pack name in a covering panel closes the panel');
    },

    async chatRowRoom() {
      const gaps = (row) => row.evaluate((item) => {
        const text = (element) => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect(); };
        const name = item.querySelector('.names').getBoundingClientRect();
        const reply = item.querySelector('.rp').getBoundingClientRect();
        const length = text(item.querySelector('.dur'));
        const menu = item.querySelector('.mb').getBoundingClientRect();
        return { name: reply.left - name.right, reply: length.left - reply.right, length: menu.left - length.right };
      });
      const apart = (spaces, what) => assert(Object.values(spaces).every((space) => space >= 0), `${what}: ${JSON.stringify(spaces)}`);
      await chatButton.click();
      await page.locator('[aria-label="새 대화"]').click();
      await compose.fill('"GNOMO"');
      await compose.press('Enter');
      await page.locator('.ans .crow').first().waitFor();
      await quiet();
      const row = page.locator('.ans .crow').first();
      await row.hover();
      apart(await gaps(row), 'hover');
      const edge = page.locator('.panel-edge');
      await edge.focus();
      for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight');
      await row.hover();
      apart(await gaps(row), 'hover at 300');
      await edge.dblclick();
      await row.locator('.names').click();
      await page.keyboard.press('Escape');
      await away();
      apart(await gaps(page.locator('.ans .crow.sel')), 'selected');
      await row.locator('.play').focus();
      await away();
      apart(await gaps(page.locator('.ans .crow:focus-within')), 'focus inside');
      await chatButton.click();
      pass('7: name, reply icon, length and menu stay apart on hover, selected, with focus inside and at the 300 panel');
    },

    async removeFromCollection() {
      await collection('뺄 모음');
      await addToCollection(rows.nth(0), '뺄 모음');
      await addToCollection(rows.nth(1), '뺄 모음');
      await rows.first().locator('.mb').click();
      assert.equal((await menuTexts()).includes('이 모음에서 제거'), false, 'only on a collection screen');
      await page.keyboard.press('Escape');
      await page.locator('.nav-c', { hasText: '뺄 모음' }).click();
      assert.equal(await count.innerText(), '소리 2개');
      await rows.first().locator('.mb').click();
      assert.deepEqual(await menuTexts(), ['즐겨찾기', '모음에 추가', '이 모음에서 제거', 'Finder에서 보기']);
      await page.getByRole('menuitem', { name: '이 모음에서 제거' }).click();
      await page.waitForFunction(() => document.querySelector('.head .count')?.textContent === '소리 1개');
      await rows.first().locator('.mb').click();
      await page.getByRole('menuitem', { name: '모음에 추가' }).click();
      const checked = page.locator('.menu.sub button', { hasText: '뺄 모음' });
      assert.equal(await checked.locator('.ck').count(), 1, 'the collection shows its check');
      await checked.click();
      await page.locator('.none p', { hasText: '모음이 비어 있습니다.' }).waitFor();
      await menuItem('모든 소리').click();
      pass('8: 이 모음에서 제거 on a collection screen, and a click on a checked collection takes the sound out');
    },

    async extras() {
      await rows.first().locator('.tile').click();
      await page.locator('.packtop').waitFor();
      await pick('길이', '0.5초 이하');
      assert.match(await page.locator('.packtop .count').innerText(), /^결과 \d+개 \/ 전체 \d+개$/, '11: the pack screen counts its filter');
      await page.locator('.filters .chip', { hasText: '즐겨찾기' }).click();
      await page.locator('.none p', { hasText: '조건에 맞는 소리가 없습니다.' }).waitFor();
      await menuItem('모든 소리').click();
      await page.locator('.filters .chip.plain.on').click();
      await page.locator('.clear-all').click();
      await rows.first().waitFor();

      await rows.first().locator('.names').click();
      await player.waitFor();
      assert((await page.locator('.player .time').boundingBox()).width >= 96, '15: the time keeps its width');
      await stopSound();

      await chatButton.click();
      await compose.fill('"laser"');
      for (let tab = 0; tab < 5; tab++) {
        await page.locator('[aria-label="새 대화"]').click();
        await compose.fill(`"laser ${tab} 긴 대화 제목"`);
        await compose.press('Enter');
        await quiet();
      }
      const strip = page.locator('.tab-list');
      await strip.evaluate((element) => { element.scrollLeft = 0; });
      await strip.hover();
      await page.mouse.wheel(0, 120);
      await page.waitForFunction(() => document.querySelector('.tab-list').scrollLeft > 0);
      await page.waitForFunction(() => document.querySelector('.tab-list').classList.contains('more-left'));
      assert.deepEqual(await page.locator('.tab').evaluateAll((tabs) => tabs.filter((tab) => getComputedStyle(tab).visibility !== 'visible').length), 0, '12: no tab is hidden');
      await shot(page, 'tabs-fade');
      await chatButton.click();
      await away();
      pass('11, 12, 15: the pack screen counts its filter and says 조건에 맞는; tabs stay drawn, fade and take the wheel; the time keeps 96px');
    },
  };
}

/** The small bugs from the review's notes. */
export function noteChecks({ page, pass, resize, setReply, away }) {
  const search = page.getByRole('searchbox', { name: '파일 이름 검색' });
  const compose = page.locator('.compose-input');
  const rows = page.locator('.list .row');
  const toggleButton = page.locator('.player .pp');
  const menuButton = page.locator('.top .ib').first();
  const LONG = 'DSGNStngr-COMBAT';
  const longName = '오래 쓰는 아주 긴 이름의 모음으로 메뉴 막대 칸을 훌쩍 넘는 경우';
  return {
    async notes() {
      await rows.nth(3).locator('.mb').click();
      await page.locator('.menu').waitFor();
      await page.locator('.list').hover();
      await page.mouse.wheel(0, 300);
      await page.locator('.menu').waitFor({ state: 'detached' });
      await page.locator('.list').evaluate((scroller) => { scroller.scrollTop = 0; });

      await search.fill(LONG);
      await page.locator('.list .row', { hasText: LONG }).first().waitFor();
      await rows.first().locator('.names').dblclick();
      await page.locator('.player .pp[aria-label="일시 정지"]').waitFor();
      assert.equal(await toggleButton.getAttribute('aria-label'), '일시 정지', 'a double click plays once');
      await resize(720);
      await page.locator('.nav').waitFor({ state: 'hidden' });
      await menuButton.click();
      await page.locator('.nav').waitFor();
      await page.locator('.nav').hover();
      await page.keyboard.press('Escape');
      await page.locator('.nav').waitFor({ state: 'hidden' });
      assert.equal(await toggleButton.getAttribute('aria-label'), '일시 정지', 'Escape on the covering menu leaves the sound playing');
      await page.keyboard.press('Escape');
      await page.locator('.player .pp[aria-label="재생"]').waitFor();
      await resize(1100);
      await menuButton.click();
      await page.locator('.nav').waitFor();

      await page.locator('[aria-label="새 모음"]').click();
      await page.locator('.nav-new').fill(longName);
      await rows.first().locator('.names').click();
      const named = page.locator('.nav-c', { hasText: longName });
      await named.waitFor();
      await page.keyboard.press('Escape');
      await named.locator('span').hover();
      await page.locator('.tip.on', { hasText: longName }).waitFor();
      await away();

      await search.fill('아주 긴 검색어가 들어와서 제목이 창 끝까지 밀려도 결과 수는 보여야 하는 경우입니다 이렇게 길게 말이지요 더더더더더더더더');
      const right = await page.locator('.head .count').evaluate((count) => count.getBoundingClientRect().right);
      assert(right <= 1100, `the count stays in the window: ${right}`);
      await search.fill('');

      await resize(1100, 480);
      await page.locator('.filters .chip', { hasText: '종류' }).click();
      const chip = await page.locator('.filters .chip', { hasText: '종류' }).boundingBox();
      const pop = await page.locator('.pop').boundingBox();
      assert(pop.y >= chip.y + chip.height || pop.y + pop.height <= chip.y, `the popover leaves its chip in sight: ${JSON.stringify({ chip, pop })}`);
      await page.keyboard.press('Escape');
      await resize(1100);

      // A low score with no such name in the library: the reason, then the sentence.
      setReply(async () => ({ ...answerPlan, english_queries: ['a cat meowing'], file_words: ['cough'] }));
      await page.locator('.chatbtn').click();
      await compose.fill('뿅뿅 뿅뿅');
      await compose.press('Enter');
      await page.locator('.ans .say.next').waitFor();
      const left = await page.locator('.ans .say').evaluateAll((lines) => lines.slice(0, 2).map((line) => line.querySelector('span').getBoundingClientRect().left));
      assert.equal(left[0], left[1], 'the second line starts under the words of the first');
      await page.locator('.chatbtn').click();
      setReply(async () => answerPlan);
      pass('notes: a menu closes on scroll, a double click plays once, Escape on a covering menu keeps the sound, a name typed before a click is kept and its tooltip shows, a long title keeps the count, a short window keeps the chip, a second line aligns');
    },
  };
}

export const reviewOrder = ['startFocus', 'firstPlayReveal', 'keysAfterMouse', 'packLink', 'listHolds', 'newCollection', 'searchLeaves', 'coveredPanel', 'chatRowRoom', 'removeFromCollection', 'extras'];
