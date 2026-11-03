// Reviews 16 and 17 on the built Mac app, driven by verify-v4-ui.mjs: real clicks and keys in the hidden window.
// allow: SIZE_OK - One journey through one page: the checks share its helpers and hand its state to each other.
// Each check leaves the screen as it found it: all sounds, no filters, menu open, panel closed, default widths.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appDir, resizeContent } from './v3-harness.mjs';

const ACCENT = 'rgb(240, 166, 58)';
const FG = 'rgb(255, 255, 255)';
const UNSURE = /^가장 가까운 3개를 먼저 골랐어요\. .+부터 들어 보고 더 자세히 말해 주세요\.$/;
const LONG_SOUND = 'computerNoise_000.ogg';
const LONGEST_SOUND = 'AMBForst_ForestBirds_OS_02';

const widthOf = (page, selector) => page.locator(selector).evaluate((element) => element.getBoundingClientRect().width);
/** Colours change over 100ms now; a value is read once the element's transitions have run. */
export const settled = (locator) => locator.evaluate((element) => Promise.all(element.getAnimations().map((motion) => motion.finished)));
export const style = (locator, name, pseudo) => locator.evaluate((element, [property, part]) => getComputedStyle(element, part)[property], [name, pseudo]);

/** The first-run screen, on an empty profile. */
export async function firstRunChecks({ page, pass, emptyFolder }) {
  const filters = page.locator('.filters');
  assert.equal(await filters.getAttribute('class'), 'filters dim', 'no library, nothing to filter');
  const chip = await page.locator('.filters .chip').first().boundingBox();
  await page.mouse.click(chip.x + chip.width / 2, chip.y + chip.height / 2);
  assert.equal(await page.locator('.pop').count(), 0, 'a click on a dim filter opens nothing');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.filters')), null, 'the keyboard skips dim filters');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.search-input')), false, 'the search box does not take focus from the folder button');
  const heading = await page.locator('.nav-h').boundingBox();
  const packs = await page.locator('.nav-i', { hasText: '팩' }).boundingBox();
  assert.equal(await page.locator('.nav-h').count(), 1, 'no empty row after 모음');
  assert(packs.y - (heading.y + heading.height) <= 14, `empty 모음 leaves a gap: ${packs.y - heading.y - heading.height}px`);
  await page.locator('.nav-i', { hasText: '즐겨찾기' }).click();
  assert.equal(await page.locator('.head h1').innerText(), '즐겨찾기', 'the title follows the menu on the first screen');
  await page.locator('.nav-i', { hasText: '모든 소리' }).click();
  pass('first run: filters are dim and dead, the search box leaves the amber button alone, empty 모음 leaves no gap');

  await page.evaluate((root) => window.fetchApp.connections.connectFolder(root), emptyFolder);
  await page.locator('.none p', { hasText: '연결한 폴더에 소리 파일이 없습니다.' }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('.skel').count(), 0, 'no waiting rows for a finished empty folder');
  assert.equal(await page.locator('.none').getByRole('button', { name: '폴더 선택하기' }).count(), 1);
  await page.evaluate((root) => window.fetchApp.connections.removeFolder(root), emptyFolder);
  await page.locator('.dropzone').waitFor();
  pass('an empty folder ends in a sentence and the folder button instead of waiting rows');
}

export function polishChecks({ app, page, pass, shot }) {
  const search = page.getByRole('searchbox', { name: '파일 이름 검색' });
  const compose = page.locator('.compose-input');
  const list = page.locator('.list');
  const menuButton = page.locator('.top .ib').first();
  const logo = page.locator('.brand');
  const resize = (width, height = 760) => resizeContent(app, page, width, height);
  const count = async () => Number((await page.locator('.head .count .num').first().innerText()).replace(/,/g, ''));
  const quiet = () => page.waitForFunction(() => !document.querySelector('.ans .dots'), null, { timeout: 60_000 });
  const lines = (answer) => answer.locator('.say').allInnerTexts();
  const pick = async (chip, option) => {
    await page.locator('.filters .chip', { hasText: chip }).click();
    await page.locator('.pop button', { hasText: option }).first().click();
  };
  const stopSound = async () => { await page.keyboard.press('Escape'); await page.locator('.player .pp[aria-label="재생"]').waitFor(); };

  /** Text vectors from a second worker of the built app, so a check can state the raw score it depends on. */
  async function bestRawScores(sentences) {
    const worker = (await fs.readdir(path.join(appDir, 'dist/renderer/assets'))).find((name) => /^worker-.*\.js$/.test(name));
    return page.evaluate(async ({ url, sentences }) => {
      const sounds = await window.fetchApp.nativeAudio.sounds();
      const model = new Worker(url, { type: 'module' });
      const vectors = await new Promise((resolve, reject) => {
        model.onmessage = ({ data }) => { if (data.type === 'result') resolve(data.vectors); if (data.type === 'error') reject(new Error(data.message)); };
        model.postMessage({ type: 'text', id: 1, sentences });
      });
      model.terminate();
      const cosine = (a, b) => {
        let dot = 0; let aa = 0; let bb = 0;
        for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
        return dot / Math.sqrt(aa * bb);
      };
      return vectors.map((vector) => sounds.filter((sound) => sound.embedding).reduce((best, sound) => Math.max(best, cosine(sound.embedding, vector)), -1));
    }, { url: new URL(`assets/${worker}`, page.url()).href, sentences });
  }

  return {
    bestRawScores,

    async startScreen() {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.addInitScript(() => {
        const marks = { rows: 0 };
        window.qaSplash = marks;
        new MutationObserver(() => {
          const shown = document.querySelector('#splash');
          if (shown && marks.seen === undefined) marks.seen = performance.now();
          if (!shown && marks.seen !== undefined && marks.gone === undefined) {
            marks.gone = performance.now();
            marks.rows = document.querySelectorAll('.list .row').length;
          }
        }).observe(document, { childList: true, subtree: true });
      });
      await page.reload();
      await page.waitForFunction(() => window.qaSplash?.gone !== undefined, null, { timeout: 30_000 });
      const marks = await page.evaluate(() => window.qaSplash);
      assert(marks.gone >= 300, `the start screen left after ${marks.gone}ms`);
      assert(marks.rows > 0, 'the list is ready when the start screen leaves');

      const markup = /<div id="splash"[\s\S]*?<\/svg><\/div>/.exec(await page.evaluate(async () => (await fetch(location.href)).text()))[0];
      await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), markup);
      const ball = page.locator('#splash .ball');
      assert.equal(await style(ball, 'animationName'), 'splash-ball');
      assert.equal(await style(ball, 'animationDelay'), '0.4s', 'the ball waits 400ms');
      assert.equal(await style(ball, 'animationDuration'), '0.6s', 'the same swing as .fetching');
      assert.equal(await style(ball, 'fill'), ACCENT, 'the amber ball of the icon');
      await page.evaluate(() => document.querySelector('#splash .ball').getAnimations().forEach((motion) => { motion.pause(); motion.currentTime = 0; }));
      await shot(page, 'app-13-start');
      await page.evaluate(() => document.querySelector('#splash .ball').getAnimations().forEach((motion) => { motion.currentTime = 1000; }));
      await shot(page, 'app-13-start-swing');
      await resize(480, 728);
      await shot(page, 'app-13-start-480');
      await resize(1100);
      await page.evaluate(() => document.querySelector('#splash').remove());
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await menuButton.click();
      await page.locator('.nav').waitFor();
      pass(`start screen: there from ${marks.seen.toFixed(0)}ms, gone at ${marks.gone.toFixed(0)}ms with ${marks.rows} rows; the ball swings after 400ms`);
    },

    async fontAndChrome() {
      const fonts = await page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].map((font) => `${font.family} ${font.status}`);
      });
      assert.deepEqual(fonts, ['Pretendard loaded'], 'the bundled font is the one in use');
      assert.match(await page.evaluate(async () => (await fetch(document.querySelector('link[rel=license]').href)).text()), /SIL OPEN FONT LICENSE/, 'the font license ships with it');
      assert.deepEqual(await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((item) => item.getTitle() === 'fetch');
        return { lights: window.getWindowButtonPosition(), minimum: window.getMinimumSize() };
      }), { lights: { x: 14, y: 15 }, minimum: [480, 480] });
      pass('Pretendard loads from the bundle; window buttons at 14, 15; the window stops at 480 by 480');
    },

    async topBar() {
      const spots = async () => ({ menu: await menuButton.boundingBox(), logo: await logo.boundingBox() });
      const open = await spots();
      assert.equal(open.menu.x, 82, 'the menu button starts at 82');
      assert.equal(await page.locator('.nav img').count(), 0, 'the logo left the menu');
      const order = await page.evaluate(() => ['.top .ib', '[aria-label="뒤로"]', '[aria-label="앞으로"]', '.brand', '.search', '.chatbtn'].map((selector) => document.querySelector(selector).getBoundingClientRect().x));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), 'menu button, back, forward, logo, search, fetch ai');
      await shot(page, 'app-14-top-bar-open');
      await menuButton.click();
      await page.locator('.nav').waitFor({ state: 'hidden' });
      assert.deepEqual(await spots(), open, 'closing the menu moves nothing');
      await shot(page, 'app-14-top-bar-closed');
      await menuButton.click();
      await page.locator('.nav').waitFor();
      assert.deepEqual(await spots(), open, 'opening the menu moves nothing');

      await menuButton.hover();
      await settled(menuButton);
      const button = await style(menuButton, 'backgroundColor');
      await logo.hover();
      await settled(logo);
      assert.equal(await style(logo, 'backgroundColor'), button, 'the logo hovers like an icon button');
      await page.mouse.move(600, 500);
      pass(`top bar: menu button at x ${open.menu.x}, logo at x ${open.logo.x}, both still with the menu open or closed; logo hover matches .ib`);
    },

    async home() {
      await page.locator('.chatbtn').click();
      await compose.fill('"laser"');
      await compose.press('Enter');
      await page.locator('.ans .crow').first().waitFor();
      const tabs = await page.locator('.tab').count();
      await page.locator('.sort').click();
      await page.locator('.pop button', { hasText: '길이순' }).click();
      await pick('길이', '0.5초 이하');
      await page.locator('.nav-i', { hasText: '설정' }).click();
      await page.locator('.nav-i', { hasText: '모든 소리' }).click();
      assert.equal(await page.locator('.filters .chip.on').count(), 1, 'the menu item 모든 소리 keeps the filters');
      // The longest sound of the demo library, so it is still playing at the end of this check.
      await search.fill(LONGEST_SOUND);
      await page.locator('.filters .chip.on .chip-x').click();
      await page.locator('.list .row').first().locator('.names').click();
      await page.locator('.player .pp[aria-label="일시 정지"]').waitFor();
      const playing = await page.locator('.player .fname').innerText();
      await search.fill('');
      await pick('길이', '0.5초 이하');
      await list.evaluate((element) => { element.scrollTop = 400; });

      await logo.click();
      await page.locator('.list .row').first().waitFor();
      assert.equal(await page.locator('.filters .chip.on').count(), 0, 'filters cleared');
      assert.equal(await search.inputValue(), '', 'search cleared');
      assert.equal(await count(), 300, 'all sounds');
      assert.equal(await list.evaluate((element) => element.scrollTop), 0, 'back at the top');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'search-input', 'focus in the search box');
      assert.deepEqual(await page.locator('.player .fname').allInnerTexts(), [playing], 'the sound keeps playing');
      assert.equal(await page.locator('.player .pp').getAttribute('aria-label'), '일시 정지', 'still playing');
      assert.equal(await page.locator('.sort').innerText(), '길이순', 'the sort stays');
      assert.equal(await page.locator('.nav').isVisible(), true, 'the menu stays open');
      assert.equal(await page.locator('.chat').isVisible(), true, 'the panel stays open');
      assert.equal(await page.locator('.tab').count(), tabs, 'the chat tabs stay');

      await page.locator('.nav-i', { hasText: '설정' }).click();
      await logo.click();
      await page.locator('.list .row').first().waitFor();
      assert.equal(await page.locator('.nav-i.on').innerText(), '모든 소리', 'home from another screen');
      await stopSound();
      await page.locator('.sort').click();
      await page.locator('.pop button', { hasText: '팩순' }).click();
      await page.locator('[aria-label="새 대화"]').click();
      await page.locator('.chatbtn').click();
      pass(`logo: all sounds, no search or filters, top of the list, focus in search; ${playing} kept playing, sort, menu, panel and tabs stayed`);
    },

    async panes() {
      const edge = (name) => page.locator(`.${name}-edge`);
      const shown = async () => ({ menu: await widthOf(page, '.nav'), panel: await widthOf(page, '.chat'), list: await widthOf(page, '.library') });
      const drag = async (name, to) => {
        const box = await edge(name).boundingBox();
        await page.mouse.move(box.x + 4, 300);
        await page.mouse.down();
        await page.mouse.move(to, 300, { steps: 3 });
        await page.mouse.up();
      };
      await page.locator('.chatbtn').click();
      assert.deepEqual(await shown(), { menu: 220, panel: 340, list: 540 }, 'default widths');
      assert.equal(await edge('panel').getAttribute('role'), 'separator');
      assert.equal(await style(edge('panel'), 'cursor'), 'col-resize');
      const grip = await edge('panel').boundingBox();
      assert.equal(grip.width, 8, 'an 8px grab area');
      assert.equal(grip.x, 1100 - 340, 'grabbed on the right of the boundary, away from the list scrollbar');
      assert.equal((await edge('menu').boundingBox()).x, 220, 'grabbed on the right of the boundary, away from the menu scrollbar');
      assert.equal(await page.evaluate(() => [...document.querySelector('.body').children].filter((child) => child.classList.contains('pane-edge')).length), 2, 'both handles sit directly in the body');

      await page.mouse.move(grip.x + 4, 300);
      assert.equal(await style(edge('panel'), 'backgroundColor', '::before'), 'rgb(69, 71, 78)', 'hover: --outline');
      assert.equal(await style(edge('panel'), 'width', '::before'), '2px');
      await page.mouse.down();
      await page.mouse.move(grip.x - 30, 300);
      assert.equal(await style(edge('panel'), 'backgroundColor', '::before'), FG, 'dragging: --fg');
      await page.evaluate(() => document.querySelector('.list .row .heart').click());
      await page.locator('.filters .chip', { hasText: '즐겨찾기' }).waitFor();
      await page.mouse.move(grip.x - 36, 300);
      assert.equal(await widthOf(page, '.chat'), 380, 'a render in mid-drag leaves the drag going');
      await page.mouse.up();
      await page.evaluate(() => document.querySelector('.list .row .heart').click());

      await drag('panel', 100);
      assert.deepEqual(await shown(), { menu: 220, panel: 400, list: 480 }, 'at 1100 the panel stops where the list keeps 480');
      await drag('menu', 700);
      assert.deepEqual(await shown(), { menu: 220, panel: 400, list: 480 }, 'at 1100 the menu stops where the list keeps 480');
      await drag('menu', 20);
      assert.equal(await widthOf(page, '.nav'), 180, 'the menu stops at 180');
      await drag('panel', 1000);
      assert.equal(await widthOf(page, '.chat'), 300, 'the panel stops at 300');
      await resize(1280, 812);
      await drag('menu', 264);
      await drag('panel', 864);
      assert.deepEqual(await shown(), { menu: 260, panel: 420, list: 600 });
      const box = await edge('panel').boundingBox();
      await page.mouse.move(box.x + 4, 300);
      await page.mouse.down();
      await shot(page, 'app-15-resize');
      await page.mouse.up();
      await edge('menu').dblclick();
      await edge('panel').dblclick();
      assert.deepEqual(await shown(), { menu: 220, panel: 340, list: 720 }, 'a double click resets');
      await resize(1100);

      await edge('panel').focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(await widthOf(page, '.chat'), 356, 'the left key moves the boundary left');
      assert.equal(await edge('panel').getAttribute('aria-valuenow'), '356');
      await page.keyboard.press('ArrowRight');
      assert.equal(await widthOf(page, '.chat'), 340, 'the right key moves it back');
      await edge('menu').focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(await widthOf(page, '.nav'), 204);
      await page.keyboard.press('ArrowRight');
      assert.equal(await widthOf(page, '.nav'), 220);

      await menuButton.click();
      await drag('panel', 100);
      assert.equal(await widthOf(page, '.chat'), 560, 'the panel stops at 560');
      assert.equal(await page.evaluate(() => localStorage.getItem('panelWidth')), '560', 'the width is saved');
      await resize(720);
      assert.deepEqual([await widthOf(page, '.chat'), await widthOf(page, '.library')], [720, 720], 'under 780 the panel covers the list');
      await shot(page, 'app-15-resize-720');
      await resize(480, 728);
      await page.waitForFunction(() => document.querySelector('#app').classList.contains('nar'));
      assert.equal(await edge('panel').isHidden(), true, 'no handle in a narrow window');
      assert.equal(await edge('menu').isHidden(), true);
      await menuButton.click();
      assert.equal(await widthOf(page, '.nav'), 220, 'the narrow menu stays at 220');
      await shot(page, 'app-15-resize-480');
      await menuButton.click();
      await resize(1100);
      assert.equal(await widthOf(page, '.chat'), 560, 'the saved width comes back');
      await page.reload();
      await page.locator('.list .row').first().waitFor();
      await page.locator('#splash').waitFor({ state: 'detached' });
      await page.locator('.chatbtn').click();
      assert.equal(await widthOf(page, '.nav'), 0, 'the menu closes first: 220 + 560 + 480 is more than 1100');
      await menuButton.click();
      assert.deepEqual(await shown(), { menu: 220, panel: 400, list: 480 }, 'a menu opened by hand shows the panel smaller, not its saved width');
      await drag('menu', 700);
      assert.equal(await widthOf(page, '.nav'), 220, 'the menu cannot take the room the list keeps');
      await resize(1000);
      await page.locator('.nav').waitFor({ state: 'hidden' });
      assert.equal(await widthOf(page, '.chat'), 520, 'a smaller window closes the menu, then the panel shrinks');
      await resize(1100);
      await edge('panel').dblclick();
      assert.equal(await page.evaluate(() => localStorage.getItem('panelWidth')), '340', 'a double click saves the default');
      await page.locator('.chatbtn').click();
      await menuButton.click();
      await page.locator('.nav').waitFor();
      pass('panes: limits, list keeps 480, shrink order, saved width back after 720 and 480, saved across a reload, double click, keys, hover and drag lines, render in mid-drag');
    },

    async rowsAndFocus() {
      const selected = () => page.evaluate(() => document.querySelector('.list .row.sel')?.dataset.id);
      const listHoldsKeys = () => page.evaluate(() => document.activeElement?.classList.contains('list'));
      await search.fill('computerNoise');
      const row = page.locator('.list .row', { hasText: LONG_SOUND });
      await row.locator('.names').click();
      await page.keyboard.press('ArrowUp');
      assert.equal(await listHoldsKeys(), true, 'the list holds the keys');
      assert.equal(await style(list, 'outlineStyle'), 'none', 'no outline around the list after a row click and a key');
      assert.equal(await style(row, 'boxShadow'), 'none', 'a selected row uses its background only');
      await page.mouse.move(600, 20);
      assert.equal(await style(row, 'backgroundColor'), 'rgb(42, 28, 8)');
      assert.equal(await style(row.locator('.play'), 'color'), ACCENT, 'a selected row that plays shows amber');
      assert.equal(await page.locator('.player .pp').getAttribute('aria-label'), '일시 정지', 'the button says what it does: a stopped sound goes on from there');
      await stopSound();
      await search.fill('');

      const chip = page.locator('.filters .chip').first();
      await chip.click();
      assert.equal(await style(chip, 'outlineStyle'), 'none', 'a mouse click shows no ring');
      await page.keyboard.press('Escape');
      await chip.focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid', 'the keyboard shows the ring');

      await pick('길이', '2초 이상');
      assert.equal(await listHoldsKeys(), true, 'choosing a filter hands the keys back to the list');
      const chosen = await selected();
      await page.keyboard.press('ArrowDown');
      assert.notEqual(await selected(), chosen, 'the down key moves after choosing a filter');
      await stopSound();
      await page.locator('.filters .chip.on .chip-x').click();
      assert.equal(await listHoldsKeys(), true, 'clearing a filter hands the keys back to the list');
      pass('keys: no list outline after a row click, ring only from the keyboard, arrow keys work after choosing and after clearing a filter');
    },

    async emptyResult() {
      await search.fill('zzzz');
      const button = await page.locator('.none .btn').boundingBox();
      const area = await page.locator('.none').boundingBox();
      assert(Math.abs(button.x + button.width / 2 - (area.x + area.width / 2)) <= 1, 'the button sits under the sentence');
      await page.getByRole('button', { name: '검색 지우기' }).click();
      await page.locator('.list .row').first().waitFor();
      pass('empty result: 검색 지우기 is centred under its sentence');
    },

    async waves() {
      const thickest = await page.locator('.list .row .wave rect').evaluateAll((bars) => Math.max(...bars.map((bar) => bar.getBoundingClientRect().width)));
      assert(thickest < 4, `row bars ${thickest}px wide read as bricks`);
      await search.fill('computerNoise');
      await page.locator('.list .row', { hasText: LONG_SOUND }).locator('.names').click();
      await page.locator('.player .bigwave').waitFor();
      const heights = await page.locator('.player .bigwave rect').evaluateAll((bars) => bars.map((bar) => Number(bar.getAttribute('height'))));
      const cell = await widthOf(page, '.player .bigwave-cell');
      assert.equal(heights.length, Math.floor(cell / 3), 'the player wave fills its cell with 2px bars and 1px gaps');
      const steps = heights.filter((height, index) => index > 0 && height === heights[index - 1]).length;
      assert(steps < heights.length / 2, `${steps} of ${heights.length} player bars repeat the one before: steps`);
      await stopSound();
      await search.fill('');
      pass(`waves: row bars at most ${thickest.toFixed(1)}px wide, the player wave stretched without steps`);
    },

    async longFilters() {
      await page.locator('.chatbtn').click();
      await page.locator('.filters .chip').first().click();
      await page.locator('.pop button').nth(1).click();
      await page.locator('.filters .chip').nth(1).click();
      await page.locator('.pop button').first().click();
      await page.locator('.filters .chip', { hasText: '길이' }).click();
      await page.locator('.pop button', { hasText: '0.5초 이하' }).click();
      const fit = await page.evaluate(() => {
        const bar = document.querySelector('.filters').getBoundingClientRect();
        const tabs = document.querySelector('.tabs').getBoundingClientRect();
        const filters = document.querySelector('.filters');
        const last = [...filters.children].filter((child) => child !== filters.querySelector('.sort')).at(-1).getBoundingClientRect();
        const sort = filters.querySelector('.sort').getBoundingClientRect();
        return { bar: bar.right, tabs: tabs.left, wraps: filters.scrollWidth <= filters.clientWidth, height: bar.height, sortRight: sort.right, sortTop: sort.top, lastBottom: last.bottom, count: document.querySelector('.head .count').getBoundingClientRect().width };
      });
      assert(fit.bar <= fit.tabs, `the filters run into the tabs: ${JSON.stringify(fit)}`);
      assert(fit.wraps && fit.height > 54, `long chips wrap: ${JSON.stringify(fit)}`);
      assert(fit.sortRight <= fit.bar - 24 + 0.5, 'the sort stays inside the gutter');
      assert(fit.count > 0, 'the count stays in the head');
      await shot(page, 'app-01b-filters-on-chat');
      await page.evaluate(() => document.querySelectorAll('.filters .chip.on .chip-x').forEach((clear) => clear.click()));
      await page.locator('.chatbtn').click();
      pass('long filters stay in their bar, away from the chat tabs');
    },

    async rowMenu() {
      await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const bottom = page.locator(`.list .row[style*="top:${(await count() - 1) * 52}px"]`);
      await bottom.waitFor();
      assert.equal(await list.evaluate((element) => element.scrollHeight), await count() * 52, 'the list is 52 for every row');
      assert.equal((await bottom.boundingBox()).height, 52);
      await bottom.locator('.mb').click();
      const menu = page.locator('.menu:not(.sub)');
      const box = await menu.boundingBox();
      assert(box.y + box.height <= 760, `the row menu runs off the window: ${JSON.stringify(box)}`);
      assert.equal(await menu.locator('button').count(), 3, 'all three items');
      const glyphs = await menu.locator('button svg:first-child').evaluateAll((icons) => icons.map((svg) => svg.innerHTML));
      assert.equal(new Set(glyphs).size, 3, 'three different icons');
      await shot(page, 'app-06-row-menu-bottom');
      await page.keyboard.press('Escape');
      await list.evaluate((element) => { element.scrollTop = 0; });

      const row = page.locator('.list .row').nth(3);
      await row.locator('.mb').click();
      const first = await menu.boundingBox();
      await page.evaluate(() => document.querySelector('.list .row .play').click());
      await menu.getByRole('menuitem', { name: '모음에 추가' }).click();
      const second = await menu.boundingBox();
      assert(Math.abs(second.y - first.y) <= 1 && Math.abs(second.x - first.x) <= 1, `the menu jumped from ${first.x},${first.y} to ${second.x},${second.y}`);
      const beside = await page.locator('.menu.sub').boundingBox();
      assert(beside.x >= second.x + second.width || beside.x + beside.width <= second.x, 'the submenu opens beside the row menu');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      pass('row menu: the bottom row opens upward, and a submenu opens beside a menu that stays where it was');
    },

    async composeFocus() {
      await page.locator('[aria-label="새 대화"]').click();
      await compose.fill('"laser"');
      await page.getByRole('button', { name: '보내기' }).click();
      await page.keyboard.type('next');
      assert.equal(await compose.inputValue(), 'next', 'typing goes on after the send button');
      await compose.fill('');
      await page.locator('.ans .crow').first().waitFor();
      await quiet();
      await page.getByRole('button', { name: '이 답에 답장' }).click();
      await page.getByRole('button', { name: '답장 취소' }).click();
      await page.keyboard.type('more');
      assert.equal(await compose.inputValue(), 'more', 'typing goes on after cancelling a reply');
      await compose.fill('');
      pass('typing goes on right after the send button and after cancelling a reply');
    },

    async chatRows() {
      const row = page.locator('.ans .crow').first();
      await row.hover();
      assert.equal(await style(row.locator('.rp'), 'position'), 'absolute', 'the reply button takes no column');
      const cards = await page.locator('.cres').first().boundingBox();
      const input = await page.locator('.compose').boundingBox();
      assert(Math.abs(cards.x + cards.width - (input.x + input.width)) <= 1, `cards end at ${cards.x + cards.width}, the input at ${input.x + input.width}`);
      assert.equal(await style(page.locator('.ans .say').first(), 'wordBreak'), 'keep-all');
      pass('chat rows: no empty reply column, cards and input share their right edge, Korean breaks between words');
    },

    async tabs() {
      for (const text of ['첫째 대화 제목입니다', '둘째 대화 제목입니다', '셋째 대화 제목입니다', '넷째 대화 제목입니다']) {
        await page.locator('[aria-label="새 대화"]').click();
        await compose.fill(`"${text}"`);
        await compose.press('Enter');
        await quiet();
      }
      const tabs = await page.evaluate(() => {
        const strip = document.querySelector('.tab-list').getBoundingClientRect();
        return [...document.querySelectorAll('.tab')].map((tab) => {
          const box = tab.getBoundingClientRect();
          return { whole: box.left >= strip.left - 0.5 && box.right <= strip.right + 0.5, drawn: getComputedStyle(tab).visibility === 'visible' };
        });
      });
      assert(tabs.some(({ whole }) => !whole), 'this many tabs must overflow');
      assert.deepEqual(tabs.filter(({ drawn }) => !drawn), [], 'a tab past the edge stays drawn');
      assert.match(await page.locator('.tab-list').getAttribute('class'), /more-(left|right)/, 'the strip fades where more tabs lie');
      await shot(page, 'app-05-chat-tabs');
      pass(`tabs: ${tabs.filter(({ whole }) => whole).length} of ${tabs.length} whole, the rest fade at the strip's edge`);
    },

    async sentences({ unsure, clear }) {
      const cut = Number(/thresholds: \{ text: ([\d.]+)/.exec(await fs.readFile(path.join(appDir, 'src/core/search/scoring.ts'), 'utf8'))[1]);
      const [low, high] = await bestRawScores([unsure, clear]);
      assert(low <= cut && high > cut, `the sentences must fall on both sides of ${cut}: ${low}, ${high}`);
      await page.locator('[aria-label="새 대화"]').click();
      await compose.fill('판정 낮은 소리');
      await compose.press('Enter');
      await page.locator('.ans').last().locator('.crow').first().waitFor({ timeout: 60_000 });
      await quiet();
      const answer = page.locator('.ans').last();
      const said = await lines(answer);
      assert(said.length === 1 && UNSURE.test(said[0]), `best raw score ${low.toFixed(3)} at or below ${cut}: the app's sentence, not ${said}`);
      assert.equal(await answer.getByRole('button', { name: '더 보기' }).count(), 1, 'more stays');
      assert.equal(await answer.locator('.crow').count(), 3, 'the results stay open');
      await shot(page, 'app-12-unsure');
      await answer.getByRole('button', { name: '더 보기' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.ans:last-of-type .crow').length === 6);
      assert.deepEqual(await lines(answer), said, 'more does not change the sentence');

      await compose.fill('판정 높은 소리');
      await compose.press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('.ans').length === 2, null, { timeout: 60_000 });
      await quiet();
      assert.deepEqual(await lines(page.locator('.ans').last()), ['3개를 가져왔어요.'], `best raw score ${high.toFixed(3)} above ${cut}: the checked sentence from the relay`);
      await shot(page, 'app-12-sure');

      await page.locator('[aria-label="새 대화"]').click();
      await compose.fill('"zzzz"');
      await compose.press('Enter');
      await page.locator('.ans .say').first().waitFor();
      assert.deepEqual(await lines(page.locator('.ans').last()), ['이 이름이 들어간 파일이 없어요. 따옴표를 빼고 찾아보세요.'], 'a quoted search with no result says so');
      pass(`sentence rule against ${cut}: ${low.toFixed(3)} gets the app's sentence, more leaves it, ${high.toFixed(3)} keeps the relay's checked line`);
    },

    async settingsRow() {
      const button = await page.getByRole('button', { name: '다시 확인' }).first().boundingBox();
      const row = await page.locator('.li').first().boundingBox();
      assert.equal(Math.round(row.x + row.width - (button.x + button.width)), 64, 'the button sits before the unlink column');
      pass('settings: 다시 확인 sits before the unlink button');
    },

    async narrowHome() {
      await page.locator('.chatbtn').click();
      const tabs = await page.locator('.tab').count();
      await logo.click();
      await page.locator('.chat').waitFor({ state: 'hidden' });
      await page.locator('.list .row').first().waitFor();
      await page.locator('.chatbtn').click();
      assert.equal(await page.locator('.tab').count(), tabs, 'the tabs stay');
      await page.locator('.chatbtn').click();
      await page.locator('.nav-i', { hasText: '팩' }).evaluate((item) => item.click());
      await page.locator('.head .count').waitFor();
      await shot(page, 'app-04-packs-480');
      await logo.click();
      await page.locator('.list .row').first().waitFor();
      pass('narrow window: the logo closes the panel and keeps its tabs; the packs screen shows its count');
    },
  };
}
