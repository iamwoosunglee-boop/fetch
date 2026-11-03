// fetch ai after the third polish: results before the sentence, the app's own sentence, waiting lines, failures,
// and the reason and range lines. Sentences come from the app's own source, so a check never retypes them.
// allow: SIZE_OK - One journey through one page: the checks share its helpers and hand its state to each other.
import assert from 'node:assert/strict';
import { sentences } from '../src/core/chat/sentences.ts';
import { checkPhrase, fallbackPhrase } from '../src/core/phrase.ts';

/** The model stub answers this sentence with a laser sound's own vector, so its best score is high. */
export const LASER = 'a sci-fi laser gun shot';
/** Its stand-in vector lands on nothing: verify-v4-ui checks this one against the real threshold. */
const UNSURE = 'a cat meowing';
const WAIT_SECONDS = [1, 5, 9, 13, 17, 21, 25, 29, 30];
const LATE_MS = 1500;
const SPOKEN_WATCH_MS = 35_000;
const REDUCED_WATCH_MS = 5_500;

export const plan = (sentence, fields = {}) => ({
  english_queries: [sentence], name_keywords: [], min_duration_seconds: null, max_duration_seconds: null, explanation: '계획의 설명입니다.', ...fields,
});
export const validPhrase = (facts) => ({ message: `${facts.count}개를 가져왔어요.` });

export function chatChecks({ page, pass, shot, relay, setPlan, setPhrase, wavs, resize }) {
  const compose = page.locator('.compose-input');
  const answer = () => page.locator('.ans').last();
  const lines = (locator) => locator.locator('.say').allInnerTexts();
  const fresh = () => page.locator('[aria-label="새 대화"]').click();
  const ask = async (text) => { await compose.fill(text); await compose.press('Enter'); };
  const settled = () => page.waitForFunction(() => document.querySelector('.ans') && !document.querySelector('.ans .dots'), null, { timeout: 30_000 });
  const lastFacts = () => relay.phraseCalls.at(-1);
  const counts = () => page.evaluate(() => {
    const { sounds } = window.__proto1State;
    return { total: sounds.length, analysed: sounds.filter(({ embedding }) => embedding).length };
  });
  const reset = () => { setPlan(async () => plan(LASER)); setPhrase(validPhrase); };

  /** Every change of the waiting line and of what a screen reader hears, with its time since now. */
  const watchWaiting = () => page.evaluate(() => {
    const seen = { began: performance.now(), lines: [], spoken: [] };
    const note = (list, text) => { if (text && list.at(-1)?.text !== text) list.push({ text, at: performance.now() - seen.began }); };
    window.qaWaiting = seen;
    window.qaWaitingWatch = new MutationObserver(() => {
      note(seen.lines, document.querySelector('.dots span')?.textContent);
      note(seen.spoken, document.querySelector('.spoken').textContent);
    });
    window.qaWaitingWatch.observe(document.querySelector('.chat-in'), { childList: true, subtree: true, characterData: true });
  });

  return {
    async sentenceFirst() {
      const held = Promise.withResolvers();
      const entered = Promise.withResolvers();
      reset();
      setPhrase(async (facts) => { entered.resolve(); await held.promise; return validPhrase(facts); });
      await fresh();
      await ask('레이저 소리');
      await entered.promise;
      await answer().locator('.dots .mk.fetching').waitFor();
      assert.equal(await answer().locator('.crow').count(), 0, 'no row before the sentence');
      assert.deepEqual(await lines(answer()), [], 'no sentence yet');
      await shot(page, 'c3-sentence-on-its-way');
      held.resolve();
      await settled();
      assert.deepEqual(await lines(answer()), ['3개를 가져왔어요.']);
      assert.equal(await answer().locator('.crow').count(), 3, 'the rows follow the sentence');
      assert.equal(await answer().evaluate((view) => view.classList.contains('flow')), true, 'the answer flows in');
      assert.equal(await answer().locator('.fw').count() > 1, true, 'word by word');
      assert.equal(await answer().locator('.crow.flow-in').count(), 3, 'the rows rise in turn');
      pass('V37: the sentence comes first with the ball alone before it, and the words and the rows flow in');
    },

    async slowSentence() {
      reset();
      setPhrase(() => new Promise(() => {}));
      await fresh();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await ask('레이저 소리');
      await settled();
      assert.equal((await lines(answer())).length, 1, 'the app sentence stands in');
      assert.equal(await answer().locator('.crow').count(), 3, 'the rows do not wait on');
      assert.equal(await answer().locator('.fw').first().evaluate((word) => getComputedStyle(word).animationName), 'none', 'reduced motion shows it at once');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      reset();
      pass('V37: a sentence still missing after 3 seconds gives way to the app sentence, and reduced motion skips the flow');
    },

    async brokenSentences() {
      const cases = [
        ['an unknown file', LASER, (facts) => `${facts.count}개를 가져왔어요. 맨 위 소리는 made_up_boom.wav예요.`],
        ['a wrong number', LASER, (facts) => `${facts.count + 4}개를 가져왔어요.`],
        ['a sound description', LASER, (facts) => `묵직한 ${facts.count}개를 가져왔어요.`],
        ['찾았어요 on a low score', UNSURE, (facts) => `가장 가까운 ${facts.count}개를 찾았어요.`],
        ['the future tense', LASER, (facts) => `${facts.count}개를 찾아볼게요.`],
      ];
      for (const [name, sentence, broken] of cases) {
        setPlan(async () => plan(sentence));
        setPhrase((facts) => ({ message: broken(facts) }));
        await fresh();
        // Korean only: an English word could match a file name, and a name match is never a low score.
        await ask('깨진 문장을 돌려주는 요청');
        await settled();
        const facts = lastFacts();
        assert.equal(facts.is_low_score, sentence === UNSURE, name);
        assert.equal(checkPhrase(broken(facts), facts), false, `${name} must break a rule`);
        assert.deepEqual(await lines(answer()), [fallbackPhrase(facts, 'search')], name);
      }
      pass(`C3: ${cases.map(([name]) => name).join(', ')}: each falls back to the app's sentence`);
    },

    async previousMessage() {
      const first = '첫 계획의 설명입니다.';
      setPlan(async (input) => plan(LASER, { explanation: input.previous_plan ? '둘째 계획의 설명입니다.' : first }));
      setPhrase(validPhrase);
      await fresh();
      await ask('레이저 소리');
      await settled();
      const [shown] = await lines(answer());
      await ask('다른 레이저 소리');
      await page.waitForFunction(() => document.querySelectorAll('.ans').length === 2 && !document.querySelector('.ans .dots'));
      const sent = relay.calls.at(-1).previous_plan.explanation;
      assert.equal(sent, first, 'the second request carries the first explanation');
      assert.notEqual(sent, shown, 'not the sentence on the screen');
      pass('C3: previous.message on the second request is the first plan\'s explanation, not the shown sentence');

      setPhrase((facts) => ({ message: `가지고 있는 소리에서 ${facts.count}개를 가져왔어요. 길이는 조금씩 달라서 하나씩 들어 보고 비교하기 좋게 모아서 가져왔어요.` }));
      await ask('긴 문장이 나오는 레이저');
      await page.waitForFunction(() => document.querySelectorAll('.ans').length === 3 && !document.querySelector('.ans .dots'));
      await answer().getByRole('button', { name: '이 답에 답장' }).click();
      await ask('더 부드럽게');
      await page.waitForFunction(() => document.querySelectorAll('.ans').length === 4 && !document.querySelector('.ans .dots'));
      const quote = page.locator('.me .quote span').last();
      const cut = await quote.evaluate((label) => ({ cut: label.scrollWidth > label.clientWidth, lines: label.getClientRects().length }));
      assert.deepEqual(cut, { cut: true, lines: 1 }, 'a long sentence in a reply stays on one line with an ellipsis');
      await shot(page, 'c3-reply-quote');
      pass('C3: a reply quotes a long sentence on one line, cut with an ellipsis');
    },

    async noEarlyResults() {
      const held = Promise.withResolvers();
      reset();
      setPlan(async () => { await held.promise; return plan(LASER); });
      await fresh();
      await ask('laser 중에 묵직한 소리');
      await answer().locator('.dots span').waitFor();
      assert.equal(await answer().locator('.crow').count(), 0, 'file-name matches wait for the sentence too');
      await shot(page, 'c4-waiting-no-early-results');
      held.resolve();
      await settled();
      assert.equal(await answer().locator('.crow').count() > 0, true);
      pass('V37: file-name matches wait with the rest, so nothing shows before the sentence');
    },

    async waitingLines() {
      const held = Promise.withResolvers();
      reset();
      setPlan(async () => { await held.promise; return plan(LASER); });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await fresh();
      await watchWaiting();
      await ask('오래 걸리는 소리');
      // Time is the behaviour here: the last line must arrive at 30 seconds and still stand after it.
      await page.waitForTimeout(SPOKEN_WATCH_MS);
      const seen = await page.evaluate(() => window.qaWaiting);
      const expected = WAIT_SECONDS.map((seconds, index) => (seconds === 30 ? sentences.waitingLong : sentences.waiting[index % 3]));
      assert.deepEqual(seen.lines.map(({ text }) => text), expected, 'the lines in order, and nothing after the long one');
      seen.lines.forEach(({ at }, index) => {
        const wanted = WAIT_SECONDS[index] * 1000;
        assert(at >= wanted - 100 && at <= wanted + LATE_MS, `line ${index} at ${Math.round(at)}ms, wanted ${wanted}ms`);
      });
      assert.deepEqual(seen.spoken.map(({ text }) => text), [sentences.waiting[0]], 'a screen reader hears only the first line');
      await shot(page, 'c4-waiting-30-seconds');
      held.resolve();
      await settled();
      assert.equal(await page.locator('.spoken').textContent(), '', 'and silence once the answer is there');
      await page.evaluate(() => window.qaWaitingWatch.disconnect());
      await page.emulateMedia({ reducedMotion: 'reduce' });
      pass(`C4: ${seen.lines.length} waiting lines in order up to ${Math.round(seen.lines.at(-1).at)}ms, the long line stays to 35 seconds, and one spoken line`);
    },

    async reducedMotion() {
      const held = Promise.withResolvers();
      reset();
      setPlan(async () => { await held.promise; return plan(LASER); });
      await fresh();
      await ask('움직임 없는 소리');
      const line = answer().locator('.dots span');
      await line.waitFor();
      // Time is the behaviour here too: the second line is due at 5 seconds.
      await page.waitForTimeout(REDUCED_WATCH_MS);
      assert.equal(await line.innerText(), sentences.waiting[0], 'the first line stays');
      assert.equal(await answer().locator('.dots .ball').evaluate((ball) => getComputedStyle(ball).animationName), 'none', 'the ball rests');
      held.resolve();
      await settled();
      pass('C4: with reduced motion the ball rests and the first line stays');
    },

    async failures() {
      const replies = [
        ['429', { status: 429, body: { error: 'RATE_LIMITED' } }],
        ['503', { status: 503, body: { error: 'BUSY' } }],
        ['504', { status: 504, raw: '<html><body><h1>504 Gateway Time-out</h1></body></html>' }],
      ];
      for (const [name, reply] of replies) {
        reset();
        setPlan(async () => reply);
        await fresh();
        await ask('laser 소리');
        const failed = answer();
        await settled();
        assert.equal(await failed.locator('.crow').count() > 0, true, `${name}: file-name matches stay`);
        assert.equal(await failed.locator('.say.err').count(), 0, `${name}: no warning with results`);
        assert.deepEqual(await lines(failed), [sentences.partial], `${name}: one sentence`);
        const sent = relay.calls.length;
        setPlan(async () => plan(LASER));
        await failed.getByRole('button', { name: '다시 시도' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.ans').length === 2 && !document.querySelector('.ans .dots'), null, { timeout: 30_000 });
        assert.equal(relay.calls.length, sent + 1, `${name}: one more request`);
        assert.deepEqual(relay.calls.at(-1), relay.calls.at(-2), `${name}: the same request`);
        assert.deepEqual((await page.locator('.me').allInnerTexts()), ['laser 소리', 'laser 소리'], `${name}: as a new answer in the same tab`);
        assert.equal((await lines(answer())).length, 1, `${name}: the new answer has its sentence`);
        assert.equal(await answer().getByRole('button', { name: '다시 시도' }).count(), 0, `${name}: nothing left to try again`);
      }
      await shot(page, 'c4-partial-and-retry');

      reset();
      setPlan(async () => ({ status: 503, body: { error: 'BUSY' } }));
      await fresh();
      await ask('결과 없는 실패');
      await settled();
      assert.deepEqual(await lines(answer()), [sentences.unavailable]);
      assert.equal(await answer().locator('.say.err').count(), 1, 'a failure with no results warns');
      assert.equal(await answer().getByRole('button', { name: '다시 시도' }).count(), 1);
      await shot(page, 'c4-failed-no-results');

      setPlan(async () => ({ status: 429, body: { error: 'DAILY_LIMIT' } }));
      await fresh();
      await ask('횟수를 다 쓴 요청');
      await settled();
      assert.deepEqual(await lines(answer()), [sentences.dailyLimit]);
      assert.equal(await answer().getByRole('button', { name: '다시 시도' }).count(), 0, 'trying again cannot help today');
      assert.equal(await answer().locator('.say.err').count(), 0, 'and nothing is broken');
      await shot(page, 'c4-daily-limit');

      const words = await page.locator('.chat-in').innerText();
      assert.doesNotMatch(words, /설명으로 찾기|파일 이름으로/, 'no answer says how it searched');
      pass(`C4: ${replies.map(([name]) => name).join(', ')} with results: no warning, one sentence, 다시 시도 sends the same request as a new answer; none of them says how it searched`);
    },

    async rangeAndReason() {
      const folder = await wavs('analysing', 8);
      reset();
      // The limit counts every sound the stand-in ever answered, so 0 is the one value that holds at once.
      await page.evaluate(() => localStorage.setItem('qa-audio-limit', '0'));
      await page.evaluate((root) => { void window.fetchApp.connections.connectFolder(root); }, folder);
      await page.waitForFunction(() => window.__proto1State.sounds.length === 308, null, { timeout: 30_000 });
      const { total, analysed } = await counts();

      await fresh();
      await ask('분석 중에 찾는 레이저');
      await settled();
      assert.deepEqual(await lines(answer()), ['3개를 가져왔어요.', sentences.analysing(analysed, total)]);
      await shot(page, 'c5-range-line');

      setPlan(async () => plan(UNSURE));
      await fresh();
      await ask('분석 중에 낮은 점수');
      await settled();
      assert.deepEqual(await lines(answer()), [fallbackPhrase(lastFacts(), 'search'), sentences.analysingLow(analysed, total)]);
      assert.equal(await answer().locator('.say.next').count(), 1, 'the range line comes under the sentence');
      await shot(page, 'c5-range-line-low');
      await page.evaluate(() => localStorage.removeItem('qa-audio-limit'));
      await page.evaluate(async (root) => { await window.fetchApp.connections.removeFolder(root); }, folder);
      await page.waitForFunction(() => document.querySelector('.strip').hidden, null, { timeout: 30_000 });

      setPlan(async () => plan(UNSURE, { file_words: ['cough'] }));
      await fresh();
      const short = '남자 기침 소리';
      await ask(short);
      await settled();
      assert.deepEqual(await lines(answer()), [sentences.missingName(short), fallbackPhrase(lastFacts(), 'search')], 'low score and no name: the reason comes first');
      await shot(page, 'c5-reason-line');

      const long = '어두운 복도 끝에서 들려오는 여자의 낮은 기침 소리';
      await fresh();
      await ask(long);
      await settled();
      assert.deepEqual(await lines(answer()), [sentences.missingName(long), fallbackPhrase(lastFacts(), 'search')], 'a long request is not repeated');
      assert.equal((await lines(answer()))[0].includes(long), false);

      setPlan(async () => plan(UNSURE, { file_words: ['laser'] }));
      await fresh();
      await ask('이름에 있는 낮은 점수');
      await settled();
      assert.deepEqual(await lines(answer()), [fallbackPhrase(lastFacts(), 'search')], 'a name hit shows neither line');
      pass('C5: the range line shows during analysis in both forms; after it a low score with no name hit gives the reason, with a name hit neither');
    },

    /** The longest waiting line and an answer at the narrowest panel, then the window at three widths. */
    async widths() {
      const held = Promise.withResolvers();
      reset();
      setPlan(async () => { await held.promise; return plan(LASER); });
      await fresh();
      await page.evaluate(() => {
        window.qaLong = document.createElement('span');
        window.qaLong.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
        window.qaLong.style.font = getComputedStyle(document.querySelector('.compose-input')).font;
        document.body.append(window.qaLong);
      });
      await ask('좁은 패널에서 기다리는 요청');
      await answer().locator('.dots').waitFor();
      const edge = page.locator('.panel-edge');
      await edge.focus();
      for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight');
      assert.equal((await page.locator('.chat').boundingBox()).width, 300, 'the smallest panel');
      const room = await answer().locator('.dots').evaluate((row) => row.clientWidth - row.querySelector('.mk').getBoundingClientRect().width - parseFloat(getComputedStyle(row).columnGap));
      const needs = await page.evaluate((lines) => lines.map((line) => { window.qaLong.textContent = line; return window.qaLong.getBoundingClientRect().width; }), [...sentences.waiting, sentences.waitingLong]);
      assert(Math.max(...needs) <= room, `every waiting line fits the 300px panel: ${needs.map(Math.round)} in ${Math.round(room)}`);
      held.resolve();
      await settled();
      await edge.dblclick();
      await page.evaluate(() => window.qaLong.remove());
      for (const [width, height] of [[1100, 760], [720, 760], [480, 728]]) {
        await resize(width, height);
        const wide = await page.evaluate(() => ['.msgs', '.say', '.compose', '.ans-actions', '.cres', '.pinned'].flatMap((selector) => [...document.querySelectorAll(selector)]
          .filter((element) => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1).map((element) => `${selector}: ${element.scrollWidth} over ${element.clientWidth}`)));
        assert.deepEqual(wide, [], `${width}px`);
        await shot(page, `c4-chat-${width}`);
      }
      await resize(1100, 760);
      if (!await page.locator('.nav').isVisible()) await page.locator('.top .ib').first().click();
      pass(`C4: every waiting line fits the 300px panel, and the chat holds at 1100, 720 and 480: longest line ${Math.round(Math.max(...needs))}px in ${Math.round(room)}px`);
    },
  };
}
