// Korean composition in every text box of the built Mac app, in a hidden window with a temp profile and a fake relay.
// Composition goes through CDP (Input.imeSetComposition, then Input.insertText), with a real render in the middle of it.
// Every check runs and reports, so one run shows all that is broken. Exits 1 when any check fails.
// Usage: npm run build && PROTO1_HIDDEN=1 nice -n 15 node scripts/verify-ime.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectAndAnalyse, demoSounds, evidenceDir, launchHidden, startFakeRelay } from './v3-harness.mjs';

const out = await evidenceDir('v4-ime');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'proto1-ime-files-'));
const library = path.join(scratch, 'sounds');
const log = [];
const note = (line) => { log.push(line); console.log(line); };
let failures = 0;
async function check(name, run) {
  try {
    const detail = await run();
    note(`PASS ${name}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    failures++;
    const got = error?.actual === undefined ? '' : ` got ${JSON.stringify(error.actual)}`;
    note(`FAIL ${name}: ${String(error?.message ?? error).split('\n')[0]}${got}`);
  }
}

let copied = 0;
for (const pack of (await fs.readdir(demoSounds)).filter((name) => !name.startsWith('.')).sort()) {
  const wavs = (await fs.readdir(path.join(demoSounds, pack))).filter((name) => name.endsWith('.wav')).sort().slice(0, 3);
  if (!wavs.length || copied >= 9) continue;
  await fs.mkdir(path.join(library, pack), { recursive: true });
  await Promise.all(wavs.map((name) => fs.copyFile(path.join(demoSounds, pack, name), path.join(library, pack, name))));
  copied += wavs.length;
}

let onPlan = () => {};
const relay = await startFakeRelay(() => {
  onPlan();
  return { english_queries: ['a sci-fi laser gun shot'], name_keywords: [], min_duration_seconds: null, max_duration_seconds: null, explanation: '레이저 소리를 가져왔어요.' };
});
const { app, page, close } = await launchHidden({ relayUrl: relay.url, holdTextModel: true });
try {
  const cdp = await app.context().newCDPSession(page);
  const composing = (text) => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  const commit = (text) => cdp.send('Input.insertText', { text });
  /** The keydown of Enter while the IME holds a syllable; the char event is what submits a form by itself. */
  const enter = (keyCode) => cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text: '\r', unmodifiedText: '\r',
  }).then(() => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }));
  /** Subscribes to the next change of the element's children; call it before what causes the change. */
  const watchChange = (selector) => page.evaluate((target) => {
    window.qaChange = new Promise((resolve) => {
      new MutationObserver((_, observer) => { observer.disconnect(); resolve(); }).observe(document.querySelector(target), { childList: true });
    });
  }, selector);
  const changed = () => Promise.race([page.evaluate(() => window.qaChange), page.waitForTimeout(30_000).then(() => { throw new Error('no render came'); })]);
  /** A heart click from script keeps the keyboard focus where it is, and saving the favorite renders the whole screen. */
  const renderWithHeart = async () => {
    await watchChange('.library');
    await page.evaluate(() => document.querySelector('.list .row .heart').click());
    await changed();
  };
  /** Remembers the focused box, so a check can tell it from a new box that looks the same. */
  await page.evaluate(() => document.addEventListener('compositionend', (event) => window.qaEnded.push(event.data), true));
  const markFocused = () => page.evaluate(() => { window.qaBox = document.activeElement; window.qaEnded = []; });
  const box = () => page.evaluate(() => ({ same: document.activeElement === window.qaBox, value: window.qaBox.value, ended: window.qaEnded }));
  const bubbles = () => page.locator('.me').count();

  await connectAndAnalyse(page, library);
  await page.waitForFunction((count) => document.querySelectorAll('.list .row').length === count, copied, { timeout: 30_000 });
  await page.locator('.chatbtn').click();
  const compose = page.locator('.compose-input');
  await compose.click();
  await markFocused();

  await check('chat: a render in mid-composition keeps the box, its value and the composition', async () => {
    await composing('ㄹ');
    await composing('레');
    await renderWithHeart();
    assert.deepEqual(await box(), { same: true, value: '레', ended: [] });
    await page.evaluate(() => document.querySelector('.list .row .play').click());
    assert.deepEqual(await box(), { same: true, value: '레', ended: [] });
    await composing('렝');
    await composing('레');
    assert.deepEqual(await box(), { same: true, value: '레', ended: [] });
  });

  await check('chat: Enter with key code 229 while composing does not send', async () => {
    const before = await bubbles();
    await enter(229);
    assert.equal(await bubbles(), before, 'a message went out');
    assert.equal(relay.calls.length, 0, 'the relay was called');
    assert.equal((await box()).value, '레');
  });

  await check('chat: Enter with key code 13 while composing does not send', async () => {
    const before = await bubbles();
    await enter(13);
    assert.equal(await bubbles(), before, 'a message went out');
    assert.equal(relay.calls.length, 0, 'the relay was called');
    await commit('레');
  });

  await check('chat: every syllable arrives once and Enter after the last one sends the whole text once', async () => {
    await compose.fill('');
    await compose.click();
    await markFocused();
    for (const [states, final] of [[['ㄹ', '레'], '레'], [['ㅇ', '이', '잊'], '이'], [['ㅈ', '저'], '저']]) {
      for (const state of states) await composing(state);
      await renderWithHeart();
      await commit(final);
    }
    assert.deepEqual(await box(), { same: true, value: '레이저', ended: ['레', '이', '저'] });
    const before = await bubbles();
    await page.keyboard.press('Enter');
    assert.equal(await bubbles(), before + 1, 'one message');
    assert.equal(await page.locator('.me').last().innerText(), '레이저');
    assert.equal(await compose.inputValue(), '', 'no syllable stays behind');
    await page.waitForFunction(() => document.querySelector('.compose-input').value === '');
  });

  await check('chat: 뿅뿅 with Enter pressed on the last syllable goes out once, whole', async () => {
    await compose.fill('');
    await compose.click();
    await markFocused();
    const before = await bubbles();
    const sent = relay.calls.length;
    await composing('뿅');
    await commit('뿅');
    for (const state of ['ㅃ', '뽀', '뿅']) await composing(state);
    await enter(229);
    assert.equal(await bubbles(), before, 'Enter on a held syllable sends nothing');
    await commit('뿅');
    assert.deepEqual(await box(), { same: true, value: '뿅뿅', ended: ['뿅', '뿅'] });
    const planned = new Promise((resolve) => { onPlan = resolve; });
    await page.keyboard.press('Enter');
    await planned;
    assert.equal(await bubbles(), before + 1, 'one message');
    assert.equal(await page.locator('.me').last().innerText(), '뿅뿅');
    assert.equal(relay.calls.length, sent + 1, 'one request');
    assert.equal(relay.calls.at(-1).text, '뿅뿅');
    assert.equal(await compose.inputValue(), '', 'no syllable stays behind');
  });

  const search = page.getByRole('searchbox', { name: '파일 이름 검색' });
  await search.click();
  await markFocused();

  await check('search: typing and a render in mid-composition keep the box, its value and the composition', async () => {
    await composing('ㅎ');
    await composing('하');
    await composing('한');
    assert.deepEqual(await box(), { same: true, value: '한', ended: [] });
    await commit('한');
    await composing('글');
    await commit('글');
    assert.deepEqual(await box(), { same: true, value: '한글', ended: ['한', '글'] });
  });

  await check('search: Enter and the down key while composing stay in the box', async () => {
    await search.fill('');
    await search.click();
    await markFocused();
    await composing('ㅎ');
    await enter(229);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    assert.deepEqual(await box(), { same: true, value: 'ㅎ', ended: [] });
    await commit('ㅎ');
    await search.fill('');
    await page.locator('.list .row').first().waitFor();
  });

  await check('search: a syllable held past the 700ms pause makes no step, and the word makes one when it ends', async () => {
    const forward = page.locator('[aria-label="앞으로"]');
    await search.fill('zz');
    await search.press('Enter');
    await page.locator('[aria-label="뒤로"]').click();
    assert.equal(await forward.isEnabled(), true, 'a step to come back to');
    await search.click();
    await markFocused();
    await composing('ㅎ');
    await composing('하');
    await page.waitForTimeout(900);
    assert.equal(await forward.isEnabled(), true, 'no step in mid-syllable');
    assert.deepEqual(await box(), { same: true, value: '하', ended: [] });
    await commit('하');
    await page.locator('[aria-label="앞으로"]:disabled').waitFor({ timeout: 2_000 });
    await page.locator('[aria-label="뒤로"]').click();
    assert.equal(await search.inputValue(), '', 'one step back undoes the word');
  });

  await check('length inputs: a render in mid-composition keeps the box, and Enter on a held syllable applies nothing', async () => {
    await page.locator('.filters .chip', { hasText: '길이' }).click();
    await page.getByRole('textbox', { name: '최소(초)' }).click();
    await markFocused();
    await composing('이');
    await renderWithHeart();
    assert.deepEqual(await box(), { same: true, value: '이', ended: [] });
    await enter(229);
    assert.equal(await page.locator('.pop').isVisible(), true, 'the form did not submit');
    assert.equal(await page.locator('.filters .chip.on').count(), 0);
    await commit('');
    await page.keyboard.press('Escape');
  });

  await page.locator('[aria-label="새 모음"]').click();
  await markFocused();

  await check('new collection: a render in mid-composition keeps the box and what was typed', async () => {
    await composing('보');
    await renderWithHeart();
    assert.deepEqual(await box(), { same: true, value: '보', ended: [] });
  });

  await check('new collection: Enter while composing does not save, and Enter after it does', async () => {
    await page.locator('.nav-new').waitFor();
    await enter(229);
    assert.equal(await page.locator('.nav-c').count(), 0, 'a collection was made in mid-composition');
    await commit('보');
    await composing('스');
    await commit('스');
    await page.keyboard.press('Enter');
    await page.locator('.nav-c', { hasText: '보스' }).waitFor({ timeout: 5_000 });
    return `${await page.locator('.nav-c').count()} collection`;
  });

  await fs.writeFile(path.join(out, 'verify-ime.log'), `${log.join('\n')}\n`);
  if (failures) throw new Error(`${failures} IME checks failed`);
  console.log('PASS verify-ime');
} finally {
  await close();
  await relay.close();
  await fs.rm(scratch, { recursive: true, force: true });
}
