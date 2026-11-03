// The eight findings of doc/discovery/20_v4_polish3_feedback.md, one check each: every check fails on the behaviour the review saw.
// allow: SIZE_OK - One journey through one page: the checks share its helpers and hand its state to each other.
import assert from 'node:assert/strict';
import { sentences } from '../src/core/chat/sentences.ts';
import { checkPhrase, fallbackPhrase } from '../src/core/phrase.ts';
import { phrasePrompt } from '../server/phrase.ts';
import { LASER, plan, validPhrase } from './polish3-chat.mjs';
import { largeFolder } from './polish3-folders.mjs';

const UNAVAILABLE_PHRASE = { status: 503, body: { error: 'BUSY' } };

function chatParts(page) {
  const compose = page.locator('.compose-input');
  const answer = () => page.locator('.ans').last();
  const lines = (locator = answer()) => locator.locator('.say').allInnerTexts();
  const ask = async (text) => { await compose.fill(text); await compose.press('Enter'); };
  const fresh = () => page.locator('[aria-label="새 대화"]').click();
  const settled = (count = 1) => page.waitForFunction((wanted) => document.querySelectorAll('.ans').length === wanted && !document.querySelector('.ans .dots'), count, { timeout: 30_000 });
  const chips = () => page.locator('.pinned .cond').allInnerTexts();
  return { answer, lines, ask, fresh, settled, chips };
}

/** Findings seen in fetch ai, on the demo library. */
export function findingChecks({ page, pass, shot, relay, setPlan, setPhrase }) {
  const { answer, lines, ask, fresh, settled, chips } = chatParts(page);
  const atBottom = () => page.locator('.msgs').evaluate((list) => list.scrollTop + list.clientHeight >= list.scrollHeight - 1);

  return {
    /** 2: a new subject leaves the length behind; a repeat or a request with no sentence keeps it. */
    async lengthStaysWithItsSubject() {
      setPhrase(validPhrase);
      setPlan(async ({ text }) => ({
        '2초 넘는 레이저': plan(LASER, { min_duration_seconds: 2 }),
        '레이저 다섯 개': plan(LASER, { result_count: 5 }),
        '같은 조건으로 더': plan(LASER, { english_queries: [] }),
        '새소리로 바꿔 줘': plan('a bird singing'),
      }[text]));
      await fresh();
      for (const [index, text] of ['2초 넘는 레이저', '레이저 다섯 개', '같은 조건으로 더'].entries()) {
        await ask(text);
        await settled(index + 1);
        assert((await chips()).includes('2초 이상'), `${text} keeps the length: ${await chips()}`);
      }
      await ask('새소리로 바꿔 줘');
      await settled(4);
      assert.equal((await chips()).some((chip) => chip.endsWith('초 이상')), false, `a new subject drops it: ${await chips()}`);
      assert.equal(relay.phraseCalls.at(-1).length_condition, null);
      pass('finding 2: a new subject drops the length; a repeat, a count and a request with no sentence keep it');
    },

    /** 3: the sentence arrives above the results; the list stays at the bottom and the row under the pointer stays put. */
    async sentenceMovesNothing() {
      setPlan(async () => plan(LASER));
      setPhrase(validPhrase);
      await fresh();
      for (const [index, text] of ['첫째 소리', '둘째 소리', '셋째 소리'].entries()) {
        await ask(text);
        await settled(index + 1);
      }
      assert.equal(await page.locator('.msgs').evaluate((list) => list.scrollHeight > list.clientHeight), true, 'the panel must overflow for this');
      const long = (facts) => ({ message: `${facts.count}개를 가져왔어요. 길이는 ${facts.length_range}이고 맨 위 소리는 ${facts.first_file}예요.` });
      const held = Promise.withResolvers();
      setPhrase(async (facts) => { await held.promise; return long(facts); });
      await ask('넷째 소리');
      await page.waitForFunction(() => {
        const last = [...document.querySelectorAll('.ans')].at(-1);
        return document.querySelectorAll('.ans').length === 4 && last.querySelector('.dots') && !last.querySelector('.crow');
      }, null, { timeout: 30_000 });
      assert.equal(await atBottom(), true, 'at the bottom before the sentence');
      held.resolve();
      await settled(4);
      assert.equal((await lines()).length, 1, 'the sentence is there');
      assert.equal(await atBottom(), true, 'the sentence and its rows land in view');
      await shot(page, 'finding-3-sentence-arrived');
      pass('finding 3: the sentence and its rows arrive together, so nothing jumps, and the list stays at the bottom');
    },

    /** 4: a failed search leaves the tab as it was; the failed answer's button goes once it was used. */
    async failureKeepsTheTab() {
      const first = '첫 계획의 설명입니다.';
      setPlan(async () => plan(LASER, { explanation: first }));
      setPhrase(validPhrase);
      await fresh();
      await ask('레이저 총 쏘는 소리');
      await settled(1);
      const pinned = await chips();
      setPlan(async () => UNAVAILABLE_PHRASE);
      await ask('더 묵직한 걸로');
      await settled(2);
      const failed = page.locator('.ans').nth(1);
      assert.deepEqual(await chips(), pinned, 'a failure takes no chip away');
      setPlan(async () => plan(LASER, { english_queries: [] }));
      await ask('더 짧게');
      await settled(3);
      assert.equal(relay.calls.at(-1).previous_plan?.explanation, first, 'the next request goes on from the last answer that worked');
      assert.notDeepEqual(await lines(), [sentences.noResults], 'and finds something');
      assert(await answer().locator('.crow').count() > 0);
      await failed.getByRole('button', { name: '다시 시도' }).click();
      await settled(4);
      assert.equal(await failed.getByRole('button', { name: '다시 시도' }).count(), 0, 'the used button goes');
      await shot(page, 'finding-4-after-failure');
      pass('finding 4: a failed search keeps the chips and the next request\'s conditions, and 다시 시도 goes from the failed answer once used');
    },

    /** 5: 이상으로, 이하로, 1-2초로, and a length small enough to need its decimals. */
    async lengthWords() {
      setPhrase(async () => UNAVAILABLE_PHRASE);
      // A file-name match leads each answer, so the score decides nothing and the plain sentence shows.
      const cases = [
        ['computerNoise 긴 소리', { min_duration_seconds: 3 }, '3초 이상', '3초 이상으로 좁혀 '],
        ['laser 짧은 소리', { max_duration_seconds: 0.5 }, '0.5초 이하', '0.5초 이하로 좁혀 '],
        ['laser 범위 소리', { min_duration_seconds: 1, max_duration_seconds: 2 }, '1-2초', '1-2초로 좁혀 '],
      ];
      for (const [text, length, chip, opening] of cases) {
        setPlan(async () => plan(LASER, length));
        await fresh();
        await ask(text);
        await settled(1);
        assert((await chips()).includes(chip), `${text}: ${await chips()}`);
        assert((await lines())[0].startsWith(opening), `${text}: ${await lines()}`);
      }
      await shot(page, 'finding-5-length-words');
      setPlan(async () => plan(LASER, { max_duration_seconds: 0.01 }));
      await fresh();
      await ask('아주아주 짧은 소리');
      await settled(1);
      assert((await chips()).includes('0.01초 이하'), `a small length keeps its decimals: ${await chips()}`);
      assert(phrasePrompt.includes('"<length_condition>으로 좁혀"'), 'the /phrase prompt knows the ending');
      pass('finding 5: 3초 이상으로 좁혀, 0.5초 이하로 좁혀, 1-2초로 좁혀, and 0.01초 이하 on the chip');
    },

    /** 6: a new request gets the normal sentence. The pack name half is in listChecks, where a name holds a period. */
    async newRequestIsNoChange() {
      setPhrase(async () => UNAVAILABLE_PHRASE);
      setPlan(async () => plan(LASER));
      await fresh();
      await ask('첫 요청');
      await settled(1);
      setPlan(async () => plan(LASER, { english_queries: ['a blaster firing', LASER] }));
      await ask('둘째 요청');
      await settled(2);
      const facts = relay.phraseCalls.at(-1);
      assert.deepEqual([facts.is_refinement, facts.changed, facts.is_low_score], [true, null, false]);
      assert.deepEqual(await lines(), [fallbackPhrase({ ...facts, is_refinement: false }, 'search')], 'the normal sentence');
      assert.equal(phrasePrompt.includes('new_description'), false, 'and the /phrase prompt has no such case');
      pass('finding 6: a new request in a tab gets the normal sentence, in the app and in the /phrase prompt');
    },

    /** 8, in fetch ai: a length that leaves nothing says so, and a repeated quoted search has nothing new. */
    async chatSaysWhyNothing() {
      setPhrase(validPhrase);
      setPlan(async () => plan(LASER, { max_duration_seconds: 0.001 }));
      await fresh();
      await ask('아주 짧은 레이저');
      await settled(1);
      assert.deepEqual(await lines(), [sentences.lengthRemoved, sentences.noResults]);
      assert.equal(await answer().getByRole('button', { name: '길이 조건 해제' }).count(), 1);
      await shot(page, 'finding-8-length-nothing');
      await fresh();
      await ask('"impactMetal"');
      await settled(1);
      await answer().getByRole('button', { name: '더 보기' }).click();
      await page.locator('.ans .say', { hasText: sentences.exhausted }).waitFor();
      await ask('"impactMetal"');
      await settled(2);
      assert.deepEqual(await lines(), [sentences.exhausted], 'the files exist; there are none left to show');
      pass('finding 8: a length that leaves nothing says what is left, and a repeated quoted search says it showed everything');
    },
  };
}

/** Finding 8 in the list, before anything is a favorite. */
export function listFindingChecks({ page, pass, shot }) {
  const search = page.getByRole('searchbox', { name: '파일 이름 검색' });
  const favorites = page.locator('.filters .chip', { hasText: '즐겨찾기' });

  return {
    async filterEmptiesASearch() {
      await search.fill('foot');
      await page.locator('.list .row').first().waitFor();
      await favorites.click();
      await page.locator('.none p', { hasText: '조건에 맞는 소리가 없습니다.' }).waitFor();
      await shot(page, 'finding-8-filter-empties-search');
      await page.getByRole('button', { name: '필터 해제' }).click();
      await page.locator('.list .row').first().waitFor();
      assert.equal(await search.inputValue(), 'foot', 'the search stays');
      await favorites.click();
      await page.locator('.none p', { hasText: '조건에 맞는 소리가 없습니다.' }).waitFor();
      await search.fill('zzzz');
      await page.locator('.none p', { hasText: '"zzzz" 검색 결과가 없습니다.' }).waitFor();
      await search.fill('');
      await favorites.click();
      await page.locator('.list .row').first().waitFor();
      pass('finding 8: a search with hits that a filter empties says 조건에 맞는 소리가 없습니다. with 필터 해제, which keeps the search');
    },
  };
}

/** Findings of a library with nothing analysed yet, on an empty profile with analysis held from the start. */
export function emptyFindingChecks({ page, pass, shot, relay, setPlan, setPhrase, base }) {
  const { answer, lines, ask, fresh, settled } = chatParts(page);

  return {
    /** 7: the list says what is happening while the folder is read. */
    async checkingSaysSo() {
      const root = await largeFolder(base, 'Checking Library');
      await page.evaluate(() => localStorage.setItem('qa-audio-limit', '0'));
      await page.evaluate((folder) => { void window.fetchApp.connections.connectFolder(folder); }, root);
      await page.locator('.none p', { hasText: '폴더를 확인하고 있습니다.' }).waitFor({ timeout: 15_000 });
      assert.equal(await page.locator('.strip').innerText(), '폴더 확인 중', 'still reading the folder');
      await shot(page, 'finding-7-checking');
      await page.locator('.list .row').first().waitFor({ timeout: 60_000 });
      pass('finding 7: the empty list says 폴더를 확인하고 있습니다. while a large folder is read');
    },

    /** 8, in the length menu: an unknown count is no 0. */
    async unknownCountIsNoZero() {
      await page.locator('.filters .chip', { hasText: '길이' }).first().click();
      const shown = await page.locator('.pop > button').evaluateAll((items) => items.map((item) => item.textContent));
      assert.deepEqual(shown, ['0.5초 이하', '0.5초에서 2초', '2초 이상'], 'no counts while no length is known');
      await shot(page, 'finding-8-length-menu');
      await page.keyboard.press('Escape');
      pass('finding 8: the length menu shows no 0 while lengths are unknown');
    },

    /** 1: nothing analysed means no score, so only names answer. */
    async nothingAnalysed() {
      await page.locator('.chatbtn').click();
      await page.locator('.compose-input').waitFor();
      setPhrase(validPhrase);
      setPlan(async () => plan(LASER, { file_words: ['cough'] }));
      const called = relay.phraseCalls.length;
      await ask('쓸쓸하고 텅 빈 공간음');
      await settled(1);
      assert.deepEqual(await lines(), [sentences.noneAnalysed], 'one fixed sentence');
      assert.equal(await answer().locator('.crow').count(), 0, 'no sound without a reason to show it');
      assert.equal(relay.phraseCalls.length, called, 'and no /phrase call');
      await shot(page, 'finding-1-no-name');

      setPlan(async () => plan(LASER, { file_words: ['small'] }));
      await fresh();
      await ask('작은 소리');
      await settled(1);
      const names = await answer().locator('.crow .fname').allInnerTexts();
      assert(names.length > 0 && names.every((name) => name.startsWith('small_')), `only file-name matches: ${names}`);
      const said = (await lines()).join(' ');
      assert.doesNotMatch(said, /가장 가까운|0개 안에서/, said);
      assert.equal(checkPhrase(said, relay.phraseCalls.at(-1)), true, 'the sentence is the checked one');
      await shot(page, 'finding-1-name-hit');
      pass('finding 1: with nothing analysed only file-name matches show; with none, one fixed sentence and no /phrase call');
    },
  };
}
