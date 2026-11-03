// fetch ai and the two edges around it: the mark, the send button, the sentences, drags onto the panel and the panes' motion.
// allow: SIZE_OK - One journey through one page: the checks share its helpers and hand its state to each other.
import assert from 'node:assert/strict';
import fs, { watch } from 'node:fs/promises';
import path from 'node:path';
import { checkHistories, lineHistories } from './chat-line-history.mjs';
import { style } from './v4-polish-checks.mjs';
import { colors } from './polish2-look.mjs';

const PROMPT = '소리를 설명하거나 파일을 끌어다 놓으세요';
const EXHAUSTED = '이 요청으로 찾은 소리는 모두 보여 드렸어요. 새 대화에서 다시 찾아보세요.';
export const answerPlan = { english_queries: ['a sci-fi laser gun shot'], name_keywords: [], min_duration_seconds: null, max_duration_seconds: null, explanation: '레이저 소리를 가져왔어요.' };

/** The next line the app writes instead of an OS drag; subscribed before the drag starts. */
export function nextDrag(profile, start) {
  const changes = watch(profile, { signal: AbortSignal.timeout(15_000) });
  const recorded = (async () => {
    for await (const event of changes) {
      if (event.filename !== 'drag-test.jsonl') continue;
      const text = await fs.readFile(path.join(profile, 'drag-test.jsonl'), 'utf8');
      if (text.endsWith('\n')) return JSON.parse(text.trim().split('\n').at(-1));
    }
    return undefined;
  })();
  return start().then(() => recorded);
}

/** Corner and middle-left pixels of a PNG data URL, read in the page. */
export const pixels = (page, png) => page.evaluate(async (url) => {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return { corner: [...context.getImageData(0, 0, 1, 1).data], inside: [...context.getImageData(4, image.height / 2, 1, 1).data] };
}, png);

export function chatChecks({ page, pass, shot, resize, relay, setReply, away, profile }) {
  const compose = page.locator('.compose-input');
  const chatButton = page.locator('.chatbtn');
  const menuButton = page.locator('.top .ib').first();
  const send = page.locator('.send');
  const fresh = () => page.locator('[aria-label="새 대화"]').click();
  const quiet = () => page.waitForFunction(() => !document.querySelector('.ans .dots'), null, { timeout: 30_000 });
  const balls = () => page.evaluate(() => ['.mk.hot', '.mk.fetching'].map((selector) => [...document.querySelectorAll(selector)].filter((mark) => mark.getClientRects().length).length));
  const side = (locator) => locator.evaluate((element) => { const box = element.getBoundingClientRect(); return [box.width, box.height]; });

  /** Samples a pane on every frame of its motion until it has settled. */
  const watchPane = (selector) => page.evaluate((target) => {
    const pane = document.querySelector(target);
    const spots = () => ['.top .ib', '.brand'].map((part) => document.querySelector(part).getBoundingClientRect().x);
    const seen = { frames: [], spots: [spots()] };
    window.qaMotion = new Promise((resolve) => {
      const frame = () => {
        const [motion] = pane.getAnimations();
        if (motion) {
          const { duration, easing } = motion.effect.getTiming();
          seen.timing = { duration, easing };
          seen.properties = Object.keys(motion.effect.getKeyframes()[0]).filter((key) => ['width', 'opacity'].includes(key));
          seen.frames.push({ width: pane.getBoundingClientRect().width, opacity: Number(getComputedStyle(pane).opacity), list: document.querySelector('.library').getBoundingClientRect().width });
          seen.spots.push(spots());
        } else if (seen.timing) {
          resolve({ ...seen, hidden: pane.hidden, moving: pane.classList.contains('pane-moving'), width: pane.getBoundingClientRect().width });
          return;
        }
        requestAnimationFrame(frame);
      };
      frame();
    });
  }, selector);
  const motionOf = async (selector, act) => {
    await watchPane(selector);
    await act();
    return page.evaluate(() => window.qaMotion);
  };
  const assertMotion = (seen, timing, what) => {
    assert.deepEqual(seen.timing, timing, what);
    assert.deepEqual(seen.properties.sort(), ['opacity', 'width'], what);
    assert(seen.frames.length >= 2, `${what}: ${seen.frames.length} frames`);
    assert(new Set(seen.spots.map(String)).size === 1, `${what}: the menu button and the logo stay: ${JSON.stringify(seen.spots)}`);
  };

  return {
    async marks() {
      setReply(async () => answerPlan);
      const mark = chatButton.locator('.mk');
      assert.deepEqual(await side(mark), [16, 16], 'top button');
      assert.equal(await style(mark.locator('.ball'), 'fill'), colors.accent, 'the ball rests on the top button while the panel is closed');
      assert.deepEqual(await balls(), [1, 0]);
      await chatButton.click();
      await compose.waitFor();
      assert.deepEqual(await side(page.locator('.msgs.empty > .mk')), [32, 32], 'empty chat: the mark alone');
      assert.equal((await page.locator('.msgs').innerText()).trim(), '', 'and no words');
      assert.equal(await mark.evaluate((svg) => svg.classList.contains('hot')), false, 'the ball moved to the panel');
      assert.deepEqual(await balls(), [1, 0]);
      await shot(page, 'chat-empty');

      let answer;
      setReply(() => new Promise((resolve) => { answer = () => resolve(answerPlan); }));
      await compose.fill('레이저');
      await compose.press('Enter');
      await page.locator('.dots .mk.fetching').waitFor();
      assert.deepEqual(await side(page.locator('.dots .mk')), [20, 20], 'loading mark');
      assert.deepEqual(await balls(), [0, 1], 'the moving ball is the only amber one');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      assert.equal(await style(page.locator('.dots .mk .ball'), 'animationName'), 'fetch-ball');
      assert.equal(await style(page.locator('.dots .mk .ball'), 'fill'), colors.accent);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await shot(page, 'chat-loading');
      answer();
      await quiet();
      setReply(async () => answerPlan);
      await compose.fill('레이저 더');
      await compose.press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('.ans').length === 2 && !document.querySelector('.ans .dots'));
      assert.deepEqual(await balls(), [1, 0]);
      assert.equal(await page.locator('.ans').last().locator('.say .mk.hot').count(), 1, 'the newest answer holds the ball');
      assert.equal(await page.locator('.ans').first().locator('.mk.hot').count(), 0);
      assert.deepEqual(await side(page.locator('.ans').last().locator('.say .mk')), [16, 16]);
      await chatButton.click();
      await page.locator('.chat').waitFor({ state: 'hidden' });
      assert.equal(await mark.evaluate((svg) => svg.classList.contains('hot')), true, 'closed again: back on the button');
      await chatButton.click();
      await compose.waitFor();
      pass('mark: top button 16, answers 16, loading 20, empty chat 32 with no words, one amber ball at every stage');
    },

    async sendButton() {
      await fresh();
      assert.equal(await compose.getAttribute('placeholder'), PROMPT);
      assert.equal(await send.isDisabled(), true, 'empty');
      await compose.fill('   ');
      assert.equal(await send.isDisabled(), true, 'spaces are not text');
      await compose.fill('레이저');
      assert.equal(await send.isEnabled(), true, 'text');
      assert.equal(await style(send, 'backgroundColor'), colors.accent);
      assert.equal(await style(send, 'color'), colors.onAccent);
      await compose.fill('');
      assert.equal(await send.isDisabled(), true);
      assert.equal(await style(send, 'backgroundColor'), 'rgba(0, 0, 0, 0)');
      const edge = page.locator('.panel-edge');
      await edge.focus();
      for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowRight');
      assert.equal((await page.locator('.chat').boundingBox()).width, 300, 'the smallest panel');
      assert.equal(await compose.evaluate((input) => {
        const context = document.createElement('canvas').getContext('2d');
        context.font = getComputedStyle(input).font;
        return context.measureText(input.placeholder).width <= input.clientWidth;
      }), true, 'the prompt fits the smallest panel');
      await edge.dblclick();
      pass('send button: Enter-shaped, on only with text; the prompt fits the 300px panel');
    },

    async sentences() {
      await fresh();
      await compose.fill('"impactMetal"');
      await compose.press('Enter');
      await page.locator('.ans .crow').first().waitFor();
      await quiet();
      assert.equal(await page.locator('.ans .crow').count(), 3);
      await page.locator('.ans').getByRole('button', { name: '더 보기' }).click();
      await page.locator('.ans .say', { hasText: EXHAUSTED }).waitFor();
      assert.equal(await page.locator('.ans').getByRole('button', { name: '더 보기' }).count(), 0, 'more goes when nothing is left');
      await shot(page, 'chat-exhausted');
      await compose.fill('"impactMetal"');
      await compose.press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('.ans').length === 2 && !document.querySelector('.ans .dots'));
      assert.deepEqual(await page.locator('.ans').last().locator('.say').allInnerTexts(), [EXHAUSTED], 'asked again in the tab');
      pass('exhausted: the sentence closes the answer, more goes away, and asking again says the same');
    },

    async rowMenu() {
      await fresh();
      await compose.fill('"laser"');
      await compose.press('Enter');
      await page.locator('.ans .crow').first().waitFor();
      await quiet();
      await away();
      const row = page.locator('.ans .crow').first();
      assert.equal(await style(row.locator('.mb'), 'visibility'), 'hidden', 'at rest the name keeps the room');
      await row.hover();
      assert.equal(await style(row.locator('.mb'), 'visibility'), 'visible');
      await row.locator('.mb').click();
      assert.deepEqual(await page.locator('.menu:not(.sub) button > span:nth-child(2)').allInnerTexts(), ['즐겨찾기', '모음에 추가', 'Finder에서 보기']);
      await page.keyboard.press('Escape');
      pass('chat results get the row menu, on hover only');
    },

    async queue() {
      const rows = page.locator('.ans .crow');
      const names = await rows.locator('.fname').allInnerTexts();
      const inPlayer = (name) => page.waitForFunction((text) => document.querySelector('.player .fname').textContent === text, name);
      const previous = page.locator('.player [aria-label="이전"]');
      const next = page.locator('.player [aria-label="다음"]');
      await rows.first().locator('.names').click();
      await inPlayer(names[0]);
      assert.deepEqual([await previous.isDisabled(), await next.isDisabled()], [true, false], 'the first answer row');
      for (const name of names.slice(1)) {
        await next.click();
        await inPlayer(name);
      }
      assert.deepEqual([await previous.isDisabled(), await next.isDisabled()], [false, true], 'the last answer row');
      pass('previous and next follow the chat answer that started the sound');
    },

    async sentenceHistories() {
      await page.locator('.nav-i', { hasText: '모든 소리' }).click();
      const results = await lineHistories(page, relay, setReply);
      checkHistories(results);
      setReply(async () => answerPlan);
      pass(`no warning on a reference failure, and no sentence that comes and goes in ${results.length} paths with 504s, slow plans and model states`);
    },

    async dragIcon() {
      await chatButton.click();
      await page.locator('.chat').waitFor({ state: 'hidden' });
      const row = page.locator('.list .row').first();
      await row.hover();
      await page.waitForFunction(() => !document.querySelector('.list .row').classList.contains('wait'));
      const entry = await nextDrag(profile, () => row.dispatchEvent('dragstart'));
      assert.deepEqual([entry.icon.width, entry.icon.height], [64, 64]);
      const { corner, inside } = await pixels(page, entry.icon.png);
      assert.equal(corner[3], 0, 'rounded corners');
      assert.equal(inside[3], 255, 'filled inside');
      pass(`drag: the row hands over ${path.basename(entry.file)} with a 64 by 64 picture of its tile`);
    },

    async prepared() {
      await page.locator('.nav-i', { hasText: '설정' }).click();
      await page.locator('.toggle').first().click();
      await page.locator('.nav-i', { hasText: '모든 소리' }).click();
      await page.mouse.move(300, 12);
      const ready = (id) => page.waitForFunction((sound) => window.fetchApp.nativeAudio.copyReady(sound), id, { timeout: 15_000 });
      const list = page.locator('.list');
      await list.evaluate((element) => { element.scrollTop = 2080; });
      await page.locator('.list .row[style*="top:2080px"]').waitFor();
      await list.focus();
      await page.keyboard.press('ArrowDown');
      await ready(await page.locator('.list .row.sel').getAttribute('data-id'));
      const after = page.locator('.list .row.sel + .row');
      const following = await after.getAttribute('data-id');
      await page.keyboard.press('Space');
      await page.locator('.player .pp[aria-label="일시 정지"]').waitFor();
      await page.locator('.player [aria-label="다음"]').click();
      await ready(following);
      await page.keyboard.press('Escape');
      await page.locator('.nav-i', { hasText: '설정' }).click();
      await page.locator('.toggle').first().click();
      await page.locator('.nav-i', { hasText: '모든 소리' }).click();
      pass('drag copies: a keyboard selection and the start of playback both prepare the WAV copy, with no pointer on the row');
    },

    async narrowDrag() {
      await resize(720);
      await page.locator('.nav').waitFor({ state: 'hidden' });
      const row = page.locator('.list .row').first();
      const name = await row.locator('.fname').innerText();
      const id = await row.getAttribute('data-id');
      const fire = (selector, type) => page.evaluate(([target, kind]) => document.querySelector(target).dispatchEvent(new DragEvent(kind, { dataTransfer: window.qaTransfer, bubbles: true, cancelable: true })), [selector, type]);
      await page.evaluate((sound) => {
        window.qaTransfer = new DataTransfer();
        window.qaTransfer.setData('application/x-proto1-sound', sound);
      }, id);
      await fire('.chatbtn', 'dragenter');
      await page.locator('.chatbtn.over').waitFor();
      await fire('.chatbtn', 'dragleave');
      await page.locator('.chatbtn.over').waitFor({ state: 'detached' });
      await page.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 600); }));
      assert.equal(await page.locator('.chat').isVisible(), false, 'passing over the button opens nothing');
      await fire('.chatbtn', 'dragenter');
      await page.locator('.chat').waitFor();
      assert.equal(await page.locator('.chatbtn.over').count(), 0);
      assert.equal((await page.locator('.chat').boundingBox()).width, 720, 'the panel covers the list');
      const hit = await page.locator('.compose').evaluate((box) => {
        const { left, top, width, height } = box.getBoundingClientRect();
        return box.contains(document.elementFromPoint(left + width / 2, top + height / 2));
      });
      assert.equal(hit, true, 'the input is on top, ready for the drop');
      await fire('.compose', 'dragover');
      await page.locator('.compose.over').waitFor();
      await fire('.compose', 'drop');
      await page.locator('.attach .fname', { hasText: name }).waitFor();
      await page.locator('.compose-input').press('Enter');
      await page.locator('.pinned .refchip', { hasText: name }).waitFor();
      await shot(page, 'narrow-drag-done');
      await chatButton.click();
      await page.locator('.chat').waitFor({ state: 'hidden' });
      await resize(1100);
      await page.locator('.nav').waitFor({ state: 'visible' }).catch(async () => { await menuButton.click(); await page.locator('.nav').waitFor(); });
      pass('narrow window: a drag resting on fetch ai opens the panel over the list and goes on to the input; passing over opens nothing');
    },

    async motion() {
      const open = { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };
      const close = { duration: 220, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const panelOpen = await motionOf('.chat', () => chatButton.click());
      assertMotion(panelOpen, open, 'the panel opens');
      assert.deepEqual([panelOpen.hidden, panelOpen.moving, panelOpen.width], [false, false, 340]);
      assert(panelOpen.frames[0].width < 340 && panelOpen.frames.at(-1).opacity <= 1, 'it grows');
      assert(panelOpen.frames[0].list > panelOpen.frames.at(-1).list, 'the list gives way as it grows');
      const panelClose = await motionOf('.chat', () => chatButton.click());
      assertMotion(panelClose, close, 'the panel closes');
      assert.deepEqual([panelClose.hidden, panelClose.moving], [true, false]);
      const menuClose = await motionOf('.nav', () => menuButton.click());
      assertMotion(menuClose, close, 'the menu closes');
      assert.equal(menuClose.hidden, true);
      const menuOpen = await motionOf('.nav', () => menuButton.click());
      assertMotion(menuOpen, open, 'the menu opens');
      assert.deepEqual([menuOpen.hidden, menuOpen.width], [false, 220]);

      await page.evaluate(() => { document.querySelector('.chatbtn').click(); document.querySelector('.chatbtn').click(); });
      await page.waitForFunction(() => !document.querySelector('.chat').getAnimations().length);
      assert.deepEqual(await page.locator('.chat').evaluate((pane) => [pane.hidden, pane.classList.contains('pane-moving')]), [true, false], 'a second click in mid-motion wins');

      await chatButton.click();
      await page.waitForFunction(() => !document.querySelector('.chat').getAnimations().length);
      const moved = () => page.locator('.chat').evaluate((pane) => pane.getAnimations().length);
      const edge = page.locator('.panel-edge');
      await edge.focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(await moved(), 0, 'keys on the edge do not animate');
      assert.equal((await page.locator('.chat').boundingBox()).width, 356, 'the width is there at once');
      const box = await edge.boundingBox();
      await page.mouse.move(box.x + 4, 300);
      await page.mouse.down();
      await page.mouse.move(box.x - 20, 300);
      assert.equal(await moved(), 0, 'dragging the edge does not animate');
      await page.mouse.up();
      await edge.dblclick();
      await chatButton.click();
      await page.waitForFunction(() => !document.querySelector('.chat').getAnimations().length);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => document.querySelector('.chatbtn').click());
      assert.equal(await moved(), 0, 'no motion when the system asks for less');
      assert.equal((await page.locator('.chat').boundingBox()).width, 340, 'and the panel is simply there');
      await chatButton.click();
      pass(`panes: open 160ms and close 120ms in width and opacity over ${panelOpen.frames.length} frames, the menu button and logo stay; none with keys, drags or reduced motion`);
    },
  };
}
