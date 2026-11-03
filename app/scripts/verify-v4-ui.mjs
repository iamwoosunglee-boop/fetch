// v4 screens on the built Mac app in hidden windows with temp profiles and a fake relay: menu at start, row grid,
// allow: SIZE_OK - This end-to-end journey shares one app/profile and fake-relay lifecycle through its sequential UI states.
// settings (autoplay), chat lines and chips, 200 characters, whole-file matching, model preload, narrow window.
// The polish reviews run through v4-polish-checks.mjs: top bar, logo, start screen, pane widths, keys, sentence rule.
// Screenshots go to .omo/evidence/v4-ui for comparison with doc/ui/mockups.
// Usage: npm run build && PROTO1_HIDDEN=1 nice -n 15 node scripts/verify-v4-ui.mjs [copy of an analysed profile]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { demoSounds, evidenceDir, launchHidden, resizeContent, startFakeRelay } from './v3-harness.mjs';
import { firstRunChecks, polishChecks } from './v4-polish-checks.mjs';

const out = await evidenceDir('v4-ui');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'proto1-v4-files-'));
const log = [];
const pass = (line) => { log.push(`PASS ${line}`); console.log(`PASS ${line}`); };
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const resize = (app, width, height) => app.evaluate(({ BrowserWindow }, size) => {
  for (const window of BrowserWindow.getAllWindows()) if (window.getTitle() === 'fetch') window.setContentSize(size.width, size.height);
}, { width, height });
// Both sentences are checked against the real raw scores in the sentence-rule check.
const UNSURE_SENTENCE = 'a cat meowing';
const CLEAR_SENTENCE = 'a sci-fi laser gun shot';

const plan = (fields) => ({ english_queries: [], name_keywords: [], min_duration_seconds: null, max_duration_seconds: null, explanation: '', ...fields });
let release;
const relay = await startFakeRelay(async (input) => {
  if (input.text.startsWith('잠깐')) await new Promise((resolve) => { release = resolve; });
  if (input.text.startsWith('아주 짧은')) return plan({ english_queries: ['a sci-fi laser gun shot'], max_duration_seconds: 0.001, explanation: '아주 짧은 소리를 가져왔어요.' });
  if (input.text.startsWith('판정 낮은')) return plan({ english_queries: [UNSURE_SENTENCE], explanation: '판정 낮은 소리를 가져왔어요.' });
  if (input.text.startsWith('판정 높은')) return plan({ english_queries: [CLEAR_SENTENCE], explanation: '판정 높은 소리를 가져왔어요.' });
  return plan({ english_queries: ['a sci-fi laser gun shot'], name_keywords: ['blaster'], explanation: '레이저 발사음을 가져왔어요.' });
});

async function firstRun() {
  const profile = path.join(scratch, 'first-run');
  await fs.mkdir(profile);
  let { app, page, close } = await launchHidden({ relayUrl: relay.url, holdTextModel: true, profile });
  await page.locator('.dropzone').waitFor();
  assert.equal(await page.locator('.nav').isVisible(), true, 'a wide window starts with the menu open');
  assert.equal(await page.locator('.head .count').count(), 0, 'no count on the empty screen');
  assert.equal(await page.locator('.dropzone .eg').count(), 0, 'the example link belongs to the web');
  await page.locator('.strip', { hasText: '분석 자료 다운로드 중' }).waitFor({ timeout: 30_000 });
  await page.locator('#splash').waitFor({ state: 'detached' });
  await shot(page, 'app-02-first-run');
  await firstRunChecks({ page, pass, emptyFolder: await fs.mkdtemp(path.join(scratch, 'empty-')) });
  pass('first run: menu open, no count, the models start arriving with no folder');

  await resize(app, 480, 728);
  await page.waitForFunction(() => document.querySelector('.nav').hidden);
  await page.reload();
  await page.locator('.dropzone').waitFor();
  assert.equal(await page.locator('.nav').isHidden(), true, 'a narrow window starts with the menu closed');
  await resize(app, 1100, 760);
  await page.locator('.top .ib').first().click();
  pass('narrow start: menu closed');

  await page.locator('.nav-i', { hasText: '설정' }).click();
  const toggle = page.getByRole('switch', { name: '자동 재생' });
  assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'autoplay is on by default');
  await toggle.click();
  const menuEdge = await page.locator('.menu-edge').boundingBox();
  await page.mouse.move(menuEdge.x + 4, 300);
  await page.mouse.down();
  await page.mouse.move(304, 300);
  await page.mouse.up();
  await close();
  ({ app, page, close } = await launchHidden({ relayUrl: relay.url, holdTextModel: true, profile }));
  await page.locator('.nav-i', { hasText: '설정' }).click();
  assert.equal(await page.getByRole('switch', { name: '자동 재생' }).getAttribute('aria-checked'), 'false', 'the setting survives a restart');
  assert.equal(await page.locator('.nav').evaluate((nav) => nav.getBoundingClientRect().width), 300, 'the menu width survives a restart');
  await page.locator('.menu-edge').dblclick();
  assert.equal(await page.locator('.nav').evaluate((nav) => nav.getBoundingClientRect().width), 220, 'a double click resets it');
  pass('autoplay setting and menu width: off and 300px survive a restart');

  await page.evaluate(() => localStorage.setItem('qa-model', 'fail'));
  await page.reload();
  const retry = page.locator('.strip').getByRole('button', { name: '다시 시도' });
  await retry.waitFor({ timeout: 30_000 });
  assert.match(await page.locator('.strip').innerText(), /분석 자료를 다운로드하지 못했습니다/);
  await page.evaluate(() => localStorage.removeItem('qa-model'));
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('audio:sounds');
    ipcMain.handle('audio:sounds', () => { throw new Error('소리 목록 실패'); });
  });
  await page.reload();
  await page.locator('.strip .err', { hasText: '소리 목록 실패' }).waitFor({ timeout: 10_000 });
  await page.locator('#splash').waitFor({ state: 'detached', timeout: 10_000 });
  await close();
  pass('model preload failure: reason and retry button in the bottom strip; a failed list load still ends the start screen');
}

async function rowsDoNotOverflow(page, label, expectedWave) {
  const size = await page.evaluate(() => {
    const list = document.querySelector('.list');
    const rows = [...document.querySelectorAll('.list .row')];
    const width = (selector) => rows[0].querySelector(selector)?.getBoundingClientRect().width ?? 0;
    return { list: list.clientWidth, content: list.scrollWidth, clipped: rows.filter((row) => row.scrollWidth > row.clientWidth).length, name: width('.names'), wave: width('.wave') };
  });
  assert.equal(size.clipped, 0, `${label}: rows clipped`);
  assert(size.content <= size.list, `${label}: list scrolls sideways`);
  assert(size.name >= 140 && size.wave === expectedWave, `${label}: name ${size.name}, wave ${size.wave}`);
  pass(`${label}: rows fit, list ${size.list}px, name ${size.name.toFixed(0)}px, wave ${size.wave.toFixed(0)}px`);
}

async function chat(page) {
  const compose = page.locator('.compose-input');
  const lines = (answer) => answer.locator('.say').allInnerTexts();
  await compose.fill('잠깐 laser 묵직한 소리');
  await compose.press('Enter');
  const waiting = page.locator('.ans').last();
  await waiting.locator('.dots').waitFor();
  assert.equal(await waiting.locator('.crow').count(), 0, 'file-name matches wait for the sentence');
  assert.deepEqual(await lines(waiting), [], 'only the ball while waiting for Haiku');
  assert.equal(await page.locator('.pinned .cond').innerText(), '잠깐 laser 묵직한 소리', 'the request is pinned as it is sent');
  await shot(page, 'app-05-chat-loading');
  release();
  await waiting.locator('.say').first().waitFor({ timeout: 120_000 });
  await page.waitForFunction(() => !document.querySelector('.ans .dots'), null, { timeout: 60_000 });
  const pinned = await page.locator('.pinned').innerText();
  assert.doesNotMatch(pinned, /파일 이름 laser/, 'typed words do not have a visible chip');
  assert.doesNotMatch(pinned, /blaster/, 'Haiku keywords stay out of the pinned bar');
  pass(`waiting shows only the ball; pinned bar: ${pinned.replace(/\s+/g, ' ')}`);

  await waiting.getByRole('button', { name: '더 보기' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ans:last-of-type .crow').length === 6);
  assert.deepEqual(await waiting.locator('.crow').evaluateAll((rows) => rows.map((row) => row.classList.contains('cut'))), [false, false, false, true, false, false]);
  assert.equal(await waiting.locator('.crow.cut').evaluate((row) => getComputedStyle(row).borderTopWidth), '1px');
  await shot(page, 'app-05-chat-more');
  pass('more: a thin line above the first row of the batch, no text');

  await page.locator('.pinned .cond').first().locator('.cond-x').click();
  await compose.fill('다른 소리로');
  await compose.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.ans').length === 2 && !document.querySelector('.ans .dots'), null, { timeout: 60_000 });
  assert.equal(relay.calls.at(-1).previous_plan, null, 'the sentence chip took the keywords with it');
  pass('removing the sentence chip also removes the keywords behind it');

  const before = relay.calls.length;
  await compose.fill('가'.repeat(201));
  await compose.press('Enter');
  const note = page.locator('.compose-note');
  assert.equal(await note.innerText(), '200자까지 입력할 수 있어요.');
  await shot(page, 'app-05-chat-limit');
  assert.equal(relay.calls.length, before, 'a long text is not sent');
  assert.equal((await compose.inputValue()).length, 201, 'the text stays to be shortened');
  await compose.fill('가'.repeat(200));
  assert.equal(await note.isHidden(), true);
  await compose.fill('');
  pass('201 characters stay unsent with the limit sentence; 200 are fine');

  await compose.fill('아주 짧은 레이저');
  await compose.press('Enter');
  await page.getByRole('button', { name: '길이 조건 해제' }).waitFor({ timeout: 30_000 });
  const cut = page.locator('.ans').last();
  assert.deepEqual(await lines(cut), ['길이가 맞지 않아 빠진 소리가 있어요.', '찾는 소리가 없어요. 다른 말로 설명해 보세요.'], 'what the search found takes the first line');
  await page.getByRole('button', { name: '길이 조건 해제' }).click();
  await page.locator('.ans').last().locator('.crow').first().waitFor();
  assert.deepEqual(await lines(page.locator('.ans').last()), ['길이 조건을 해제하고 3개를 먼저 가져왔어요.'], 'relaxing says what changed');
  pass('a length cut says why it is empty; 길이 조건 해제 brings results and says what changed');

}

async function dropOnChat(page, file) {
  await page.evaluate(() => { document.querySelector('#qa-file')?.remove(); const input = document.createElement('input'); input.type = 'file'; input.id = 'qa-file'; input.hidden = true; document.body.append(input); });
  await page.setInputFiles('#qa-file', file);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(document.querySelector('#qa-file').files[0]);
    document.querySelector('.msgs').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
}

async function references(page, rows) {
  const source = rows.find((row) => row.relativePath.endsWith('laserLarge_000.ogg'));
  const copy = path.join(scratch, 'renamed copy.ogg');
  await fs.copyFile(path.join(demoSounds, source.relativePath), copy);
  await page.locator('[aria-label="새 대화"]').click();
  const typed = page.locator('.compose-input');
  await typed.fill('묵직하게');
  await dropOnChat(page, copy);
  const waiting = page.locator('.attach .fname', { hasText: 'laserLarge_000.ogg' });
  await waiting.waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('.ans').count(), 0, 'dropping a sound does not search');
  assert.equal(await typed.inputValue(), '묵직하게', 'dropping a sound keeps what was typed');
  await typed.fill('');
  assert.equal(await page.locator('.compose .send').isDisabled(), false, 'a waiting sound turns the send button on');
  await page.locator('[aria-label="넣은 소리 빼기"]').click();
  assert.equal(await waiting.count(), 0, 'the x takes the waiting sound off');
  assert.equal(await page.locator('.compose .send').isDisabled(), true, 'with nothing to send the button is off');
  await dropOnChat(page, copy);
  await waiting.waitFor({ timeout: 30_000 });
  await typed.press('Enter');
  await page.locator('.pinned .refchip', { hasText: 'laserLarge_000.ogg' }).waitFor({ timeout: 30_000 });
  assert.equal(await waiting.count(), 0, 'sending takes the waiting sound off the input');
  await page.locator('.ans .say', { hasText: /넣어 주신 소리와 비슷한 \d+개를 다른 팩에서/ }).waitFor({ timeout: 30_000 });
  await shot(page, 'app-05-chat-reference');
  pass('a renamed copy outside the library is found by content and takes the sound name and packs');

  await page.locator('.pinned .refchip .ref-play').click();
  await page.locator('.player .fname', { hasText: 'laserLarge_000.ogg' }).waitFor();
  pass('a library sound plays from its chip');

  await page.locator('.pinned .refchip .cond-x').click();
  assert.equal(await page.locator('.pinned .refchip').count(), 0, 'the x removes the reference chip');
  pass('reference chip has an x');

  const wav = rows.find((row) => row.relativePath.endsWith('.wav'));
  const changed = path.join(scratch, 'outside.wav');
  await fs.writeFile(changed, Buffer.concat([await fs.readFile(path.join(demoSounds, wav.relativePath)), Buffer.alloc(4)]));
  await dropOnChat(page, changed);
  await page.locator('.attach .fname', { hasText: 'outside.wav' }).waitFor({ timeout: 30_000 });
  await page.locator('.attach .ref-play').click();
  await page.locator('.player .fname', { hasText: 'outside.wav' }).waitFor();
  pass('a file from outside the library plays from its chip and shows in the player');
  await page.locator('.compose-input').press('Enter');
  await page.locator('.pinned .refchip', { hasText: 'outside.wav' }).waitFor({ timeout: 30_000 });
  await page.locator('.ans .say', { hasText: /^넣어 주신 소리와 비슷한 \d+개를 (먼저 )?가져왔어요\.$/ }).waitFor({ timeout: 30_000 });
  pass('a file that is not in the library gets the sentence without other packs');
}

async function analysingSentence(page, rows) {
  const folder = path.join(scratch, 'more sounds');
  await fs.mkdir(folder);
  const wavs = rows.filter((row) => row.relativePath.endsWith('.wav')).slice(0, 12);
  await Promise.all(wavs.map(async (row, index) => fs.writeFile(path.join(folder, `new${index}.wav`),
    Buffer.concat([await fs.readFile(path.join(demoSounds, row.relativePath)), Buffer.alloc(4 + index)]))));
  const compose = page.locator('.compose-input');
  await page.locator('[aria-label="새 대화"]').click();
  await compose.fill('잠깐 분석 중인 소리');
  await compose.press('Enter');
  await page.locator('.ans .dots').waitFor();
  await page.evaluate(() => localStorage.setItem('qa-audio-limit', '2'));
  await page.evaluate((root) => window.fetchApp.connections.connectFolder(root), folder);
  await page.locator('.strip', { hasText: '소리 분석 중' }).waitFor({ timeout: 30_000 });
  const list = page.locator('.list');
  await list.evaluate((element) => { element.scrollTop = 2000; });
  await page.locator('.filters .chip').first().click();
  const moved = await page.locator('.strip .num').innerText();
  await page.evaluate(() => localStorage.setItem('qa-audio-limit', '6'));
  await page.waitForFunction((value) => document.querySelector('.strip .num')?.textContent !== value, moved, { timeout: 30_000 });
  assert.equal(await page.locator('.pop').isVisible(), true, 'the pack menu stays open during analysis');
  assert.equal(await list.evaluate((element) => element.scrollTop), 2000, 'the list stays put during analysis');
  await shot(page, 'blocker-1-menu-during-analysis');
  await page.keyboard.press('Escape');
  pass('blocker 1: menu and scroll survive analysis progress');
  release();
  await page.locator('.ans .say', { hasText: /아직 (분석 중이라 )?[\d,]+개 중 [\d,]+개 안에서만 찾았어요\./ }).waitFor({ timeout: 30_000 });
  await shot(page, 'app-05-chat-analysing');
  await page.evaluate(() => localStorage.removeItem('qa-audio-limit'));
  await page.waitForFunction(() => document.querySelector('.strip')?.hidden === true, null, { timeout: 120_000 });
  pass('a search during analysis says how far it reached');

  await fs.rename(path.join(folder, 'new0.wav'), path.join(folder, 'moved0.wav'));
  await fs.rm(path.join(folder, 'new1.wav'));
  await page.evaluate((root) => window.fetchApp.connections.rescanFolder(root), folder);
  await page.locator('.nav-i', { hasText: '설정' }).click();
  const tracked = page.locator('details.track summary');
  await tracked.first().waitFor({ timeout: 30_000 });
  assert.deepEqual((await tracked.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ')), ['사라진 파일 1개', '이동한 파일 1개']);
  await tracked.nth(1).click();
  await shot(page, 'app-09-settings-tracking');
  await page.evaluate((root) => window.fetchApp.connections.removeFolder(root), folder);
  await page.locator('.nav-i', { hasText: '모든 소리' }).click();
  pass('settings keeps file tracking: missing and moved files');
}

async function keys(page, chatRows) {
  const toggleTo = async (on) => {
    await page.locator('.nav-i', { hasText: '설정' }).click();
    const toggle = page.getByRole('switch', { name: '자동 재생' });
    if (await toggle.getAttribute('aria-checked') !== String(on)) await toggle.click();
    await page.locator('.nav-i', { hasText: '모든 소리' }).click();
  };
  const playing = () => page.locator('.player .fname').allInnerTexts();
  const selected = () => page.locator('.list .row.sel .fname').innerText();

  // A real click on the row's play button: the button is replaced, and the arrow keys must keep working.
  await page.locator('.list .row .play').first().click();
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('list')), true, 'the list keeps focus after the play button');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.deepEqual(await playing(), [await selected()], 'autoplay on: the keys play');
  await page.locator('.list .row', { hasText: await selected() }).locator('.names').click();
  await toggleTo(false);
  await page.locator('.list .row.sel .names').click();
  const held = await playing();
  const from = await selected();
  await page.keyboard.press('ArrowDown');
  assert.notEqual(await selected(), from, 'autoplay off: the selection moves');
  assert.deepEqual(await playing(), held, 'autoplay off: nothing new plays');
  await page.keyboard.press('Enter');
  assert.deepEqual(await playing(), [await selected()], 'Enter still plays');

  await page.locator('.compose-input').press('ArrowUp');
  const onRow = page.locator('.crow.sel .fname');
  await onRow.waitFor();
  const name = await onRow.textContent();
  assert.notDeepEqual(await playing(), [name], 'autoplay off: the chat keys only move');
  await page.locator('.msgs').press('ArrowUp');
  assert.notEqual(await onRow.textContent(), name, 'the chat selection moves');
  await page.locator('.msgs').press('Enter');
  assert.deepEqual(await playing(), [await onRow.textContent()], 'Enter plays the selected result');
  pass(`autoplay off: list and chat keys move without playing, Enter plays (${chatRows} chat rows)`);
  await toggleTo(true);
  await page.locator('.compose-input').press('ArrowUp');
  await page.locator('.crow.now').waitFor();
  pass('autoplay on: the chat keys play');
}

async function settings(page) {
  await page.locator('.nav-i', { hasText: '설정' }).click();
  await shot(page, 'app-09-settings');
  assert.equal(await page.getByRole('button', { name: '내보내기', exact: true }).count(), 0, 'no CSV row');
  assert.equal(await page.locator('select').count(), 0, 'no pack depth selector');
  pass('settings: folders and autoplay, with no CSV row and no pack depth selector');
}

async function narrow(app, page, polish) {
  await resize(app, 480, 728);
  await page.waitForFunction(() => document.querySelector('#app').classList.contains('nar'));
  await shot(page, 'app-06-narrow-settings');
  await page.locator('.top .ib').first().click();
  await page.locator('.nav-i', { hasText: '모든 소리' }).click();
  await page.locator('.list .row').first().waitFor();
  assert.equal(await page.locator('.nav').isHidden(), true, 'the menu closes after choosing');
  for (const selector of ['.tile', '.wave', '.heart']) assert.equal(await page.locator(`.list .row ${selector}`).first().isHidden(), true, `${selector} hidden`);
  await shot(page, 'app-06-narrow-list');
  await page.locator('.list .row .mb').first().click();
  await shot(page, 'app-06-narrow-menu');
  await page.keyboard.press('Escape');
  await page.locator('.chatbtn').click();
  await shot(page, 'app-06-narrow-chat');
  await page.locator('.chatbtn').click();
  await polish.narrowHome();
  await resizeContent(app, page, 1100, 760);
  await page.waitForFunction(() => !document.querySelector('#app').classList.contains('nar'));
  pass('480px: settings, list, row menu and chat rendered');
}

async function blockers(page) {
  const list = page.locator('.list');
  await list.evaluate((element) => { element.scrollTop = 3000; });
  const liked = page.locator('.list .row').nth(12);
  await liked.hover();
  await liked.locator('.heart').click();
  await page.locator('.chatbtn').click();
  await page.locator('.chatbtn').click();
  assert.equal(await list.evaluate((element) => element.scrollTop), 3000, 'a heart and the chat button keep the scroll position');
  await liked.hover();
  await liked.locator('.heart').click();
  await page.locator('.filters .chip').first().click();
  await page.evaluate(() => window.fetchApp.collections.load());
  await page.waitForFunction(() => document.querySelector('.pop'));
  await page.keyboard.press('Escape');
  await list.evaluate((element) => { element.scrollTop = 0; });
  pass('blocker 1: heart and chat button keep the list where it was');

  const compose = page.locator('.compose-input');
  for (const text of ['첫 요청', '둘째 요청', '셋째 요청']) {
    await compose.fill(text);
    await compose.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.ans .dots') && !document.querySelector('.tab .busy'), null, { timeout: 60_000 });
    await page.locator('.ans').last().locator('.crow').first().waitFor({ timeout: 60_000 });
  }
  const messages = page.locator('.msgs');
  await messages.evaluate((element) => { element.scrollTop = 0; });
  const first = page.locator('.ans .crow').first();
  await first.hover();
  assert.equal(await messages.evaluate((element) => element.scrollTop), 0, 'hovering a result keeps the chat where it was');
  await first.locator('.play').click();
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('msgs')), true, 'the chat keeps focus after its play button');
  assert.equal(await messages.evaluate((element) => element.scrollTop), 0, 'playing an early result keeps the chat where it was');
  await page.keyboard.press('ArrowDown');
  await page.locator('.crow.sel').nth(0).waitFor();
  await shot(page, 'blocker-2-early-result');
  pass('blocker 2 and 3: early chat results stay reachable; keys work after the chat play button');
  await page.keyboard.press('Escape');
  await page.locator('[aria-label="새 대화"]').click();
}

try {
  await firstRun();

  const reused = process.argv[2];
  const { app, page, close } = await launchHidden({ relayUrl: relay.url, testDrag: true, seeded: true, profile: reused });
  try {
    await page.waitForFunction(() => Number(document.querySelector('.head .count .num')?.textContent?.replace(/,/g, '')) === 300, null, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('.strip')?.hidden === true, null, { timeout: 600_000 });
    await shot(page, 'app-00-start');
    assert.equal(await page.locator('.nav').isVisible(), true);
    const polish = polishChecks({ app, page, pass, shot });
    await polish.fontAndChrome();
    await polish.topBar();
    await polish.waves();
    await polish.rowsAndFocus();
    await polish.emptyResult();
    await polish.longFilters();
    await polish.rowMenu();
    await polish.panes();
    await polish.home();
    await polish.startScreen();
    const rows = await page.evaluate(async () => (await window.fetchApp.nativeAudio.sounds()).map(({ relativePath, packName }) => ({ relativePath, packName })));
    assert.equal(new Set(rows.map((row) => row.packName)).size, 9, 'the demo folders stay 9 packs');
    await page.locator('.list .row').nth(4).click();
    await page.locator('.chatbtn').click();
    await rowsDoNotOverflow(page, 'menu and chat open at the default size', 0);
    await blockers(page);
    await page.locator('.chatbtn').click();
    await resize(app, 900, 760);
    await page.waitForFunction(() => innerWidth === 900);
    await page.locator('.chatbtn').click();
    assert.equal(await page.locator('.nav').isHidden(), true, 'below 1040px the chat closes the menu');
    await page.locator('.top .ib').first().click();
    pass('major 6: below 1040px opening the chat closes the menu');
    assert.equal(await page.locator('.chat').evaluate((panel) => panel.getBoundingClientRect().width), 300, 'a menu opened by hand leaves the panel its lower limit');
    const squeezed = await page.evaluate(() => { const list = document.querySelector('.list'); return [list.scrollWidth, list.clientWidth, list.querySelector('.row').scrollWidth, list.querySelector('.row').clientWidth]; });
    assert(squeezed[0] <= squeezed[1] && squeezed[2] <= squeezed[3], `a smaller window keeps rows inside: ${squeezed}`);
    await shot(page, 'app-01b-squeezed-900');
    await resize(app, 720, 760);
    await page.waitForFunction(() => innerWidth === 720);
    const narrowRows = await page.evaluate(() => [...document.querySelectorAll('.list .row')]
      .map((row) => [row.scrollWidth, row.clientWidth]));
    assert(narrowRows.every(([content, width]) => content <= width), `720px row overflow: ${JSON.stringify(narrowRows)}`);
    await shot(page, 'app-01b-squeezed-720');
    await resize(app, 1100, 760);
    await page.waitForFunction(() => innerWidth === 1100);
    assert.equal(await page.locator('.nav').isHidden(), true, 'the smaller window closed the menu');
    await page.locator('.top .ib').first().click();
    await chat(page);
    await shot(page, 'app-01b-nav-chat');
    await polish.chatRows();
    await polish.sentences({ unsure: UNSURE_SENTENCE, clear: CLEAR_SENTENCE });
    await polish.tabs();
    await polish.composeFocus();
    await references(page, rows);
    await analysingSentence(page, rows);
    await keys(page, await page.locator('.crow').count());
    await page.locator('.chatbtn').click();
    await settings(page);
    await polish.settingsRow();
    await narrow(app, page, polish);
    assert.equal(await page.locator('body').innerText().then((text) => text.includes('앞에서 들은 소리는 뺐어요')), false);
  } finally {
    await close();
  }
  await fs.writeFile(path.join(out, 'verify-v4-ui.log'), `${log.join('\n')}\n`);
  console.log('PASS verify-v4-ui');
} finally {
  await relay.close();
  await fs.rm(scratch, { recursive: true, force: true });
}
