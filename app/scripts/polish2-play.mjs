// Playback: the played share of a wave, seeking, the keys and who gets them first, previous and next, volume.
import assert from 'node:assert/strict';
import { style } from './v4-polish-checks.mjs';
import { colors } from './polish2-look.mjs';

const LONG = 'DSGNStngr-COMBAT';
const STEADY = 'computerNoise';
const FEW = 'impactMetal';
const PLAYED = 'rgb(107, 82, 40)';

export function playChecks({ page, pass, away }) {
  const search = page.getByRole('searchbox', { name: '파일 이름 검색' });
  const rows = page.locator('.list .row');
  const row = rows.first();
  const toggleButton = page.locator('.player .pp');
  const playing = () => page.locator('.player .pp[aria-label="일시 정지"]').waitFor();
  const paused = () => page.locator('.player .pp[aria-label="재생"]').waitFor();
  const previous = page.locator('.player [aria-label="이전"]');
  const next = page.locator('.player [aria-label="다음"]');
  const clock = () => page.locator('.player .time').evaluate((time) => {
    const position = Number(time.querySelector('b').textContent);
    return { position, share: position / parseFloat(time.querySelector('span').textContent.replace('/', '')) };
  });
  const bars = (wave) => wave.evaluate((svg) => ({ on: svg.querySelectorAll('.on').length, past: svg.querySelectorAll('.past').length }));
  const near = (actual, wanted, what) => assert(Math.abs(actual - wanted) < 0.06, `${what}: ${actual}, wanted about ${wanted}`);
  const stopped = async () => { if (await toggleButton.isVisible() && await toggleButton.getAttribute('aria-label') === '일시 정지') { await page.keyboard.press('Escape'); await paused(); } };
  const only = async (query) => { await stopped(); await search.fill(query); await page.waitForFunction((text) => document.querySelector('.head h1').textContent.includes(text), query); };
  const clickWave = async (locator, share) => {
    const box = await locator.boundingBox();
    await page.mouse.click(box.x + box.width * share, box.y + box.height / 2);
  };

  return {
    bars,
    LONG,

    async seek() {
      await only(LONG);
      await clickWave(row.locator('.wave'), 0.5);
      await playing();
      near((await clock()).share, 0.5, 'the row wave starts from where it was clicked');
      assert.equal(await row.getAttribute('aria-selected'), 'true', 'a wave click selects its row');
      await clickWave(page.locator('.player .bigwave-cell'), 0.25);
      await playing();
      near((await clock()).share, 0.25, 'the player wave moves playback');
      pass('wave click: the row wave and the player wave both start from the place clicked');
    },

    async played() {
      const wave = row.locator('.wave');
      await page.keyboard.press('Escape');
      await paused();
      const stoppedBars = await bars(wave);
      assert(stoppedBars.on > 10, `the place stays after stopping: ${JSON.stringify(stoppedBars)}`);
      assert.equal(await style(wave.locator('.on').first(), 'fill'), colors.accent, 'the current sound in amber');
      await only(STEADY);
      await rows.first().locator('.names').click();
      await playing();
      await page.keyboard.press('Escape');
      await paused();
      await only(LONG);
      const past = await bars(wave);
      assert.equal(past.on, 0, 'another sound took the amber');
      assert(past.past > 10, `what was heard stays: ${JSON.stringify(past)}`);
      assert.equal(await style(wave.locator('.past').first(), 'fill'), PLAYED, 'a past sound in --played');
      pass(`played share: ${stoppedBars.on} of 80 bars stay amber after stopping and ${past.past} stay in --played after another sound`);
    },

    async keys() {
      await only(LONG);
      await row.locator('.names').click();
      await playing();
      await page.keyboard.press('Space');
      await paused();
      const held = await clock();
      await page.keyboard.press('Space');
      await playing();
      assert((await clock()).position >= held.position, 'Space goes on from where it stopped');
      const before = await clock();
      await page.keyboard.press('ArrowRight');
      near((await clock()).share, before.share + 0.2, 'right jumps 20% of the length');
      await page.keyboard.press('ArrowLeft');
      near((await clock()).share, 0, 'left plays from the start');
      await playing();

      await search.focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowRight');
      assert.equal(await search.inputValue(), `${LONG} `, 'in a box the keys type and move the caret');
      assert.equal(await toggleButton.getAttribute('aria-label'), '일시 정지', 'a box keeps the keys from playback');
      await search.fill(LONG);
      await stopped();
      pass('Space stops and goes on, right jumps 20%, left restarts, and none of them leave a box');
    },

    async selectionApart() {
      await page.locator('.nav-i', { hasText: '설정' }).click();
      await page.locator('.toggle').first().click();
      await page.locator('.nav-i', { hasText: '모든 소리' }).click();
      await only(STEADY);
      const first = rows.nth(0);
      const second = rows.nth(1);
      await first.locator('.names').click();
      await playing();
      await page.keyboard.press('ArrowDown');
      assert.equal(await second.getAttribute('aria-selected'), 'true', 'the selection moved');
      assert.equal(await first.evaluate((item) => item.classList.contains('now')), true, 'the sound did not');
      assert.equal(await second.evaluate((item) => item.classList.contains('now')), false, 'only the sound that plays shows it');
      const name = await second.locator('.fname').innerText();
      await page.keyboard.press('Space');
      await page.waitForFunction((text) => document.querySelector('.player .fname').textContent === text, name);
      await playing();
      await stopped();
      await page.locator('.nav-i', { hasText: '설정' }).click();
      await page.locator('.toggle').first().click();
      await page.locator('.nav-i', { hasText: '모든 소리' }).click();
      pass('selection and playing are separate: the keys move one while the other plays, and Space takes the selected row');
    },

    async priority() {
      await only(LONG);
      await row.locator('.names').click();
      await playing();
      await row.locator('.mb').click();
      const menu = page.locator('.menu:not(.sub)');
      await menu.waitFor();
      await page.keyboard.press('Space');
      assert.equal(await toggleButton.getAttribute('aria-label'), '일시 정지', 'Space stays with the open menu');
      const at = await page.evaluate(() => document.querySelector('.list .row.sel')?.dataset.id);
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), '즐겨찾기', 'down moves in the menu');
      assert.equal(await page.evaluate(() => document.querySelector('.list .row.sel')?.dataset.id), at, 'not in the list');
      const place = await clock();
      await page.keyboard.press('ArrowRight');
      assert((await clock()).share < place.share + 0.1, 'right does not skip while a menu is open');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowRight');
      await page.locator('.menu.sub').waitFor();
      assert.equal(await page.evaluate(() => document.querySelector('.menu.sub').contains(document.activeElement)), true, 'the submenu takes the keys');
      await page.keyboard.press('ArrowLeft');
      await page.locator('.menu.sub').waitFor({ state: 'detached' });
      await page.keyboard.press('ArrowRight');
      await page.locator('.menu.sub').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.menu.sub').waitFor({ state: 'detached' });
      assert.equal(await menu.isVisible(), true, 'Escape closes one level');
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      assert.equal(await toggleButton.getAttribute('aria-label'), '일시 정지', 'Escape on a menu leaves the sound playing');
      await page.keyboard.press('Escape');
      await paused();
      pass('an open menu takes arrows, Space and Escape before playback, level by level; the next Escape stops the sound');
    },

    async previousAndNext() {
      await only(FEW);
      const names = await page.locator('.list .row .fname').allInnerTexts();
      assert(names.length >= 3, 'needs a short list');
      const inPlayer = (name) => page.waitForFunction((text) => document.querySelector('.player .fname').textContent === text, name);
      await rows.first().locator('.names').click();
      await inPlayer(names[0]);
      assert.equal(await previous.isDisabled(), true, 'nothing before the first row');
      assert.equal(await next.isDisabled(), false);
      await next.click();
      await inPlayer(names[1]);
      assert.equal(await rows.nth(1).getAttribute('aria-selected'), 'true', 'the selection follows');
      await previous.click();
      await inPlayer(names[0]);
      await rows.nth(names.length - 1).locator('.names').click();
      await inPlayer(names.at(-1));
      assert.equal(await next.isDisabled(), true, 'nothing after the last row');
      assert.equal(await previous.isDisabled(), false);

      await rows.first().locator('.names').click();
      await inPlayer(names[0]);
      await search.fill('computerNoise_000');
      await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 1);
      await next.click();
      await inPlayer(names[1]);
      await stopped();
      await rows.first().locator('.names').click();
      await inPlayer('computerNoise_000.ogg');
      assert.deepEqual([await previous.isDisabled(), await next.isDisabled()], [true, true], 'one result: both dim');
      await stopped();
      await search.fill('');
      pass('previous and next follow the list that started the sound, stop at its ends, and go dim for a single result');
    },

    async volume() {
      await only(LONG);
      await row.locator('.names').click();
      await playing();
      const slider = page.locator('.slider');
      assert.equal(await slider.inputValue(), '100', 'starts at 100');
      await page.evaluate(() => {
        window.qaSlider = document.querySelector('.slider');
        window.qaBarChanges = 0;
        new MutationObserver((changes) => { window.qaBarChanges += changes.length; }).observe(document.querySelector('.volume'), { childList: true });
      });
      await slider.focus();
      await page.evaluate(() => new Promise((resolve) => { let left = 10; const frame = () => (left-- ? requestAnimationFrame(frame) : resolve()); frame(); }));
      assert.equal(await page.evaluate(() => document.activeElement === window.qaSlider && document.querySelector('.slider') === window.qaSlider && window.qaBarChanges === 0), true, 'playing frames leave the slider alone');
      await slider.fill('40');
      assert.equal(await page.evaluate(() => localStorage.getItem('volume')), '40');
      assert.equal(await slider.evaluate((input) => input.style.getPropertyValue('--v')), '40%');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await slider.inputValue(), '39', 'the left key belongs to the slider');
      assert.equal(await toggleButton.getAttribute('aria-label'), '일시 정지');
      await slider.fill('40');
      await page.locator('[aria-label="음소거"]').click();
      assert.equal(await slider.inputValue(), '0', 'mute empties the slider');
      assert.equal(await page.evaluate(() => localStorage.getItem('muted')), '1');
      await stopped();
      await search.fill('');
      await away();
      pass('volume: the slider survives playing frames, the value and mute are stored, and its keys stay its own');
    },

    async afterRestart() {
      await page.locator('.list .row').first().waitFor();
      assert.equal(await page.locator('.player').isVisible(), false, 'no sound yet');
      await page.keyboard.press('Space');
      assert.equal(await page.locator('.player').isVisible(), false, 'Space with nothing selected and no sound does nothing');
      assert.equal(await page.locator('.slider').inputValue(), '0', 'still muted');
      assert.equal(await page.locator('.volume .ib').getAttribute('aria-label'), '음소거 해제');
      await only(LONG);
      assert.deepEqual(await bars(row.locator('.wave')), { on: 0, past: 0 }, 'the played share lasts for one run of the app');
      await row.locator('.names').click();
      await playing();
      await page.locator('.volume .ib').click();
      assert.equal(await page.locator('.slider').inputValue(), '40', 'the volume comes back from before the restart');
      await stopped();
      await search.fill('');
      pass('restart: volume 40 and mute are kept, the played share is gone');
    },
  };
}
