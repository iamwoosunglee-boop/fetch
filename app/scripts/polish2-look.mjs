// How the screen looks and reacts: colours, rows, tooltips, pressed states and the four window widths.
import assert from 'node:assert/strict';
import { settled, style } from './v4-polish-checks.mjs';

export const colors = {
  bg: 'rgb(17, 18, 20)', bar: 'rgb(35, 37, 42)', accent: 'rgb(240, 166, 58)', accentHover: 'rgb(245, 185, 94)', accentPress: 'rgb(217, 148, 49)',
  onAccent: 'rgb(17, 18, 20)', rowSel: 'rgb(42, 28, 8)', rowSelHover: 'rgb(51, 35, 12)', outline: 'rgb(69, 71, 78)', outlinePress: 'rgb(57, 59, 65)', fg: 'rgb(255, 255, 255)',
};
const SHADOW = 'rgba(0, 0, 0, 0.35) 0px -2px 6px 0px';

export function lookChecks({ page, pass, shot, resize, away, pick }) {
  const search = page.getByRole('searchbox', { name: '파일 이름 검색' });
  const firstRow = page.locator('.list .row').first();
  const chip = page.locator('.filters .chip.on').first();

  return {
    async surfaces() {
      await firstRow.locator('.names').click();
      await page.locator('.player .pp[aria-label="일시 정지"]').waitFor();
      await away();
      for (const bar of ['.top', '.player']) assert.equal(await style(page.locator(bar), 'backgroundColor'), colors.bar, bar);
      assert.equal(await style(page.locator('.player'), 'boxShadow'), SHADOW, 'the player casts the only shadow');
      assert.equal(await style(page.locator('.top'), 'boxShadow'), 'none');
      assert.equal((await page.locator('.player').boundingBox()).height, 61, '60 and its line');
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), colors.bg);
      assert.equal(await style(page.locator('.nav'), 'backgroundColor'), colors.bg);
      pass('bars are lifted above the body and only the player casts a shadow');
    },

    async selected() {
      const row = page.locator('.list .row.sel');
      assert.equal(await style(row, 'backgroundColor'), colors.rowSel, 'selected');
      assert.equal(await style(row.locator('.play'), 'color'), colors.accent, 'play icon');
      await row.hover();
      assert.equal(await style(row, 'backgroundColor'), colors.rowSelHover, 'selected under the pointer');
      await away();
      await page.keyboard.press('Escape');
      await page.locator('.player .pp[aria-label="재생"]').waitFor();
      assert.equal(await style(row, 'backgroundColor'), colors.rowSel, 'selected and paused');
      assert.equal(await style(row.locator('.play'), 'color'), colors.accent, 'selected and paused keeps its icon');
      pass('selected row: rest, under the pointer and paused all stay in the amber range');
    },

    async chosen() {
      await pick('길이', '0.5초 이하');
      assert.equal(await style(chip, 'backgroundColor'), colors.accent, 'active chip');
      assert.equal(await style(chip, 'color'), colors.onAccent);
      assert.equal(await chip.locator('.chip-x').count(), 1, 'an active chip has its X');
      await page.locator('.filters .chip', { hasText: '0.5초 이하' }).locator('.chip-b').click();
      assert.equal(await style(page.locator('.pop .ck').first(), 'color'), colors.accent, 'the check in a menu');
      const apply = page.locator('.pop .primary');
      assert.equal(await style(apply, 'backgroundColor'), colors.accent, 'primary button');
      assert.equal(await style(apply, 'color'), colors.onAccent);
      await apply.hover();
      assert.equal(await style(apply, 'backgroundColor'), colors.accentHover, 'primary under the pointer');
      await page.mouse.down();
      assert.equal(await style(apply, 'backgroundColor'), colors.accentPress, 'primary pressed');
      await away();
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await chip.locator('.chip-x').click();

      const current = page.locator('.nav-i.on');
      assert.equal(await style(current, 'backgroundColor'), colors.rowSel, 'current menu item');
      assert.equal(await style(current, 'color'), colors.accent);
      assert.equal(await style(current.locator('.i'), 'color'), colors.accent);

      await page.locator('.chatbtn').click();
      assert.equal(await style(page.locator('.tab.on'), 'backgroundColor', '::after'), colors.accent, 'active tab');
      assert.equal(await style(page.locator('.tab.on'), 'height', '::after'), '2px');
      await page.locator('.chatbtn').click();

      await page.locator('.nav-i', { hasText: '설정' }).click();
      const toggle = page.locator('.toggle').first();
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      assert.equal(await style(toggle, 'backgroundColor'), colors.accent, 'switch');
      await page.locator('.nav-i', { hasText: '모든 소리' }).click();

      await page.locator('.top .ib').first().focus();
      await page.keyboard.press('Tab');
      assert.deepEqual(await page.evaluate(() => { const { outlineStyle, outlineWidth, outlineColor } = getComputedStyle(document.activeElement); return [outlineStyle, outlineWidth, outlineColor]; }), ['solid', '2px', colors.accent], 'keyboard ring');
      pass('amber on the active chip with X, menu check, primary button with hover and press, current menu item, tab, switch and keyboard ring');
    },

    async motionOfColors() {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      for (const selector of ['.top .ib', '.chatbtn', '.filters .chip']) {
        const control = page.locator(selector).first();
        assert.match(await style(control, 'transitionDuration'), /^0\.1s/, selector);
        assert.match(await style(control, 'transitionTimingFunction'), /^ease-out/, selector);
        assert.match(await style(control, 'transitionProperty'), /background-color/, selector);
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      pass('colours change over 100ms ease-out');
    },

    async rows() {
      await page.waitForFunction(() => document.querySelectorAll('.list .row').length > 8);
      const shape = await page.evaluate(() => {
        const box = (selector, root = document) => root.querySelector(selector).getBoundingClientRect();
        const row = document.querySelector('.list .row');
        return {
          height: box('.row', document).height, tile: [box('.tile', row).width, box('.tile', row).height], play: box('.play', row).width,
          gutter: row.getBoundingClientRect().left - box('.library').left, dur: box('.dur', row).width, draggable: row.getAttribute('draggable'),
          handles: document.querySelectorAll('.grip').length, step: row.nextElementSibling ? parseInt(row.nextElementSibling.style.top, 10) - parseInt(row.style.top, 10) : 52,
        };
      });
      assert.deepEqual(shape, { height: 52, tile: [36, 36], play: 28, gutter: 24, dur: 56, draggable: 'true', handles: 0, step: 52 });
      for (const [width, bars, wave] of [[1100, 80, 239], [1000, 64, 191], [850, 40, 119]]) {
        await resize(width);
        await page.waitForFunction((count) => document.querySelectorAll('.list .row .wave')[0]?.childElementCount === count, bars);
        assert.equal(Number(await page.locator('.list .row .wave').first().getAttribute('width')), wave, `${width}: wave width`);
      }
      await resize(790);
      await page.waitForFunction(() => document.querySelector('.library').getBoundingClientRect().width < 572 && !document.querySelector('.list .wave'));
      await resize(1100);
      await page.waitForFunction(() => document.querySelector('.list .row .wave'));
      pass('rows: 52 high, tile 36, gutter 24, no handle, wave 239, 191, 119 and none under 572 by list width');
    },

    async tooltips() {
      const tip = page.locator('.tip');
      const tipWait = async (selector, hover) => {
        await page.evaluate((target) => {
          const shown = document.querySelector('.tip');
          const element = document.querySelector(target);
          window.qaTip = new Promise((resolve) => {
            let from;
            element.addEventListener('pointerover', () => { from ??= performance.now(); });
            new MutationObserver(() => { if (shown.classList.contains('on')) resolve(performance.now() - from); }).observe(shown, { attributes: true });
          });
        }, selector);
        await hover();
        return page.evaluate(() => window.qaTip);
      };
      const menuButton = page.locator('.top .ib').first();
      await away();
      // An earlier step may have just closed a tooltip, and the next one would then skip the wait.
      await page.waitForTimeout(350);
      const buttonWait = await tipWait('.top .ib', () => menuButton.hover());
      assert(buttonWait >= 1_480 && buttonWait < 1_900, `a button waits 1.5 seconds: ${buttonWait}`);
      assert.equal(await tip.innerText(), '메뉴');
      assert.equal(await style(tip, 'backgroundColor'), colors.fg, 'white');
      assert.equal(await style(tip, 'color'), 'rgb(18, 18, 20)');
      assert.equal(await style(tip, 'fontSize'), '12px');
      assert.equal(await style(tip, 'borderRadius'), '6px');
      const box = await tip.boundingBox();
      assert(box.x >= 12 && box.x + box.width <= 1100 - 12, `inside the window: ${JSON.stringify(box)}`);
      const warm = await tipWait('.list .row .mb', () => firstRow.locator('.mb').hover());
      assert(warm < 200, `the next button right after a tooltip does not wait: ${warm}`);
      await away();
      // The tooltip must stay away: only passing time can show that.
      await page.waitForTimeout(350);
      assert.equal(await firstRow.locator('.heart').isVisible(), true, 'the heart shows with no cursor on the row');
      await firstRow.locator('.tile').hover();
      await page.waitForTimeout(1_700);
      assert.equal(await page.locator('.tip.on').count(), 0, 'a tile has no tooltip');
      await firstRow.locator('.play').hover();
      await page.waitForTimeout(1_700);
      assert.equal(await page.locator('.tip.on').count(), 0, 'a row play button has no tooltip');
      await firstRow.locator('.fname').hover();
      await page.locator('.tip.on').waitFor({ state: 'detached' });
      await away();

      await search.fill('');
      await resize(480, 728);
      await page.waitForFunction(() => document.querySelector('#app').classList.contains('nar'));
      await search.fill('DSGNStngr-COMBAT');
      const cut = page.locator('.list .row .fname').first();
      await page.waitForFunction(() => { const name = document.querySelector('.list .row .fname'); return name && name.scrollWidth > name.clientWidth; });
      const waited = await tipWait('.list .row .fname', () => cut.hover());
      assert(waited >= 1_480 && waited < 1_900, `a cut name waits 1.5 seconds: ${waited}`);
      assert.equal(await tip.innerText(), await cut.innerText(), 'the whole name');
      const long = await tip.boundingBox();
      assert(long.x >= 12 && long.x + long.width <= 480 - 12, `the tooltip stays in a narrow window: ${JSON.stringify(long)}`);
      await away();
      await search.fill('');
      await resize(1100);
      await page.locator('.top .ib').first().click();
      await page.locator('.nav').waitFor();
      pass(`tooltips: buttons after ${Math.round(buttonWait)}ms and the next at once after ${Math.round(warm)}ms, tiles and row play quiet, a cut file name after ${Math.round(waited)}ms, one overlay inside the window`);
    },

    async pressed() {
      const control = page.locator('.top .ib').first();
      const box = await control.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal(await style(control, 'backgroundColor'), colors.outline, 'hover');
      await page.mouse.down();
      assert.equal(await style(control, 'backgroundColor'), colors.outlinePress, 'pressed is a little darker');
      await page.mouse.move(600, 500);
      await page.mouse.up();
      assert.equal(await style(control, 'backgroundColor'), 'rgba(0, 0, 0, 0)', 'rest');
      const chipOff = page.locator('.filters .chip').first();
      const area = await chipOff.boundingBox();
      await page.mouse.move(area.x + 6, area.y + 6);
      await page.mouse.down();
      assert.equal(await style(chipOff, 'backgroundColor'), colors.outlinePress, 'a chip pressed');
      await page.mouse.move(600, 500);
      await page.mouse.up();
      await page.keyboard.press('Escape');
      pass('pressed state: buttons and chips go a little darker while held and come back');
    },

    async widths() {
      const overflow = () => page.evaluate(() => {
        const wide = (selector) => [...document.querySelectorAll(selector)].filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.className);
        return {
          page: document.documentElement.scrollWidth - innerWidth,
          parts: wide('.top, .filters, .head, .list, .player, .row, .player .volume'),
        };
      });
      await page.locator('.list .row').first().locator('.names').click();
      await page.keyboard.press('Escape');
      await pick('길이', '0.5초 이하');
      for (const name of ['종류', '팩']) {
        await page.locator('.filters .chip', { hasText: name }).first().click();
        await page.locator('.pop button').filter({ hasNot: page.locator('.num.c', { hasText: /^0$/ }) }).first().click();
      }
      for (const [width, height] of [[1100, 760], [780, 760], [720, 760], [480, 728]]) {
        await resize(width, height);
        await page.waitForFunction(() => !document.querySelector('.nar') || document.querySelector('.compact'));
        assert.deepEqual(await overflow(), { page: 0, parts: [] }, `${width}: nothing runs past the window`);
        await page.locator('.filters .chip-b').last().click();
        const pop = await page.locator('.pop').boundingBox();
        assert(pop.x >= 12 && pop.x + pop.width <= width - 12, `${width}: the popover keeps 12 from the edge: ${JSON.stringify(pop)}`);
        await page.keyboard.press('Escape');
        await shot(page, `width-${width}`);
        assert.equal(await page.locator('.nav').isVisible(), width >= 780, `${width}: the menu`);
        assert.equal(await page.locator('.list .row .tile').count() > 0, width >= 720, `${width}: tiles`);
      }
      const shown = await page.evaluate(() => [...document.querySelectorAll('.player button, .player .names, .player .time, .player input, .player .tile-slot, .player .bigwave-cell')]
        .filter((element) => element.getClientRects().length).map((element) => element.getAttribute('aria-label') ?? element.className));
      assert.deepEqual(shown.filter((name) => !name.startsWith('names') && !name.startsWith('num') && !name.startsWith('fname')), ['이전', '재생', '다음', await page.locator('.player .pack').getAttribute('aria-label'), '음소거'], '480: transport, name, position, speaker');
      assert.equal(await page.locator('.player .time').isVisible(), true);
      await resize(1100);
      await page.locator('.top .ib').first().click();
      await page.locator('.nav').waitFor();
      await page.locator('.clear-all').click();
      pass('widths 1100, 780, 720, 480: no overflow with active chips, popovers 12 from the edge, the menu closes under 780, rows shrink under 720, the 480 player keeps its parts');
    },
  };
}
