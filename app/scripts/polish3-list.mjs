// The list after the third polish: the search box, lengths, packs, the player's clock, the search log and the words.
// Two libraries: the demo sounds, and a temp library whose lengths and pack names are chosen for the checks.
// allow: SIZE_OK - One journey through one page: the checks share its helpers and hand its state to each other.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { shortPackNames } from '../src/renderer/v3/format.ts';
import { nextDrag } from './polish2-chat.mjs';
import { LASER, plan, validPhrase } from './polish3-chat.mjs';
import { wav } from './polish3-folders.mjs';
import { appDir } from './v3-harness.mjs';

/** What the old rule cut down: "& Leevi ...", "2 Melodic House Essentials Volume", "Night Rider", "Essential Techno Vol." */
const PACK_NAMES = ['Lenno & Leevi Nu-Disco Yacht Rock', 'Serum 2 Melodic House Essentials Volume 5', 'Night Rider 2', 'Essential Techno Vol. 2'];
/** The left column of spec 8's table and the sentences spec 5 and 15.2 replaced, as they stood in the code. */
const OLD_STRINGS = [
  '폴더 더하기', '분석 끝', '폴더 고르기', '끌어 놓거나 고르세요', '예시 소리를 내려받으세요', '파일을 끌어 놓으세요', '챗봇에게 보낼 말', '설명으로 찾는 중',
  '필터 풀기', '전체 풀기', '조건 풀기', '} 풀기', '음소거 풀기', '즐겨찾기에서 빼기', '모음에 넣기', '이 모음에서 빼기', '모음에 넣을 수 있습니다', '} 빼기',
  '연결 끊기', '연결을 끊을까요', '사람이 정한 분류', '내려받기', '소리를 내려받지 못했습니다', '분석 자료 내려받는 중', '분석 자료를 내려받지 못했습니다',
  '최근 가져온 순', '옮길 때 바로 재생', '없어진 파일', '옮겨진 파일', '에서 옮김', '같은 파일 묶음', '분류 결정', '새로 정하기', '전에 정한 분류',
  '이 화면은 아직 분류할', '직접 고를 소리', '`파일 이름 $', '브라우저가 폴더 접근을', '인터넷을 확인하고 다시 확인을', 'Edge에서 열립니다',
  '읽지 못해 WAV 사본을', 'WAV 사본을 준비하는 중', '잠시 뒤 다시 끌어 주세요', '본보기로 읽지', 'noFileMatch', 'downloading:', 'preparing:',
];

/** The whole library of the second journey; the first folder level is the pack. */
export async function writeListLibrary(root) {
  const [lenno, serum, rider, techno] = PACK_NAMES;
  const files = {
    'Field Kit/WAV/Ambience/rain_loop.wav': wav(0.4, 300),
    'Field Kit/WAV/Movement/steps_fast.wav': wav(0.3, 320),
    'Field Kit/direct_hit.wav': wav(0.2, 340),
    [`${lenno}/groove_one.wav`]: wav(1.36, 360),
    [`${serum}/pad_two.wav`]: wav(2, 380),
    [`${rider}/tick_short.wav`]: wav(0.01, 400),
    [`${techno}/drone_long.wav`]: wav(72, 420),
    [`${techno}/drone_longest.wav`]: wav(1800, 440),
    [`${techno}/broken_sound.wav`]: Buffer.from('this file only looks like a sound'),
    [`${techno}/broken_copy.ogg`]: Buffer.from('and so does this one'),
  };
  await Promise.all(Object.entries(files).map(async ([file, bytes]) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), bytes);
  }));
  return Object.keys(files).length;
}

const stripComment = (line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line);

async function sourceLines(folder) {
  const entries = await fs.readdir(folder, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && /\.(ts|css)$/.test(entry.name)).map((entry) => path.join(entry.parentPath, entry.name));
  const texts = await Promise.all(files.map(async (file) => ({ file, lines: (await fs.readFile(file, 'utf8')).split('\n') })));
  return texts.flatMap(({ file, lines }) => lines.map((line, index) => ({ at: `${path.relative(appDir, file)}:${index + 1}`, line: stripComment(line) })));
}

/** The demo library: real clicks in the first journey. */
export function demoChecks({ page, pass, shot, wavs, relay, setPlan, setPhrase, profile }) {
  const search = page.getByRole('searchbox', { name: '파일 이름 검색' });
  const rows = page.locator('.list .row');
  const chip = (name) => page.locator('.filters .chip', { hasText: name }).first();

  return {
    async searchWhileTyping() {
      for (const typed of ['fo', 'foot', 'footste', 'footstep']) {
        await search.fill(typed);
        await page.waitForFunction((word) => document.querySelector('.head h1').textContent.includes(word), typed);
        const found = Number((await page.locator('.head .count .result').innerText()).replace(/,/g, ''));
        assert(found > 0, `${typed}: ${found}`);
        assert.equal(await page.locator('.none').count(), 0, `${typed}: no empty sentence while typing`);
      }
      assert.match(await rows.first().locator('.fname').innerText(), /foot/i);
      await search.fill('');
      pass('C8: the search box matches the last word by its start: fo, foot and footste all find sounds');
    },

    async kindsStartUnclassified() {
      await chip('종류').click();
      const shown = await page.locator('.pop > *').evaluateAll((items) => items.slice(0, 2).map((item) => [item.tagName, item.textContent]));
      assert.equal(shown[0][0], 'BUTTON');
      assert.match(shown[0][1], /^미분류/);
      assert.equal(shown[1][0], 'HR', 'a line between it and the named kinds');
      await shot(page, 'c8-kinds');
      await page.keyboard.press('Escape');
      pass('15.2: 미분류 comes first in the kind list');
    },

    /** V40: the kinds above stay, the screen behind them goes, and a route that still names it opens all sounds. */
    async noClassifyScreen() {
      assert.equal(await page.locator('.nav-i', { hasText: '분류' }).count(), 0, 'no 분류 in the menu');
      await page.evaluate(() => {
        window.__proto1State.route = { view: 'classify' };
        window.__proto1Render();
      });
      assert.equal(await page.locator('.head h1').innerText(), '모든 소리');
      assert.deepEqual(await page.locator('.nav-i.on').allInnerTexts(), ['모든 소리'], 'the menu marks where it landed');
      assert((await rows.count()) > 0, 'the sounds show');
      await page.locator('.nav-i', { hasText: '모든 소리' }).click();
      pass('V40: the menu has no 분류, and an old classify route lands on all sounds');
    },

    async unknownLengths() {
      const root = await wavs('unmeasured', 4);
      await page.evaluate(() => localStorage.setItem('qa-audio-limit', '0'));
      await page.evaluate((folder) => { void window.fetchApp.connections.connectFolder(folder); }, root);
      await page.waitForFunction(() => window.__proto1State.sounds.filter(({ duration }) => !duration).length === 4, null, { timeout: 30_000 });
      const known = await page.evaluate(() => window.__proto1State.sounds.filter(({ duration }) => duration > 0 && duration <= 0.5).length);
      await chip('길이').click();
      const item = page.locator('.pop button', { hasText: '0.5초 이하' });
      assert.equal(await item.locator('.num').innerText(), String(known), 'the menu counts known lengths only');
      await item.click();
      assert.equal(await page.locator('.head .count .result').innerText(), String(known));
      await search.fill('unmeasured');
      await page.locator('.none').waitFor();
      await search.fill('');
      await chip('0.5초 이하').locator('.chip-b').click();
      await page.locator('.pop button', { hasText: '0.5초 이하' }).click();
      await page.evaluate(async (folder) => { await window.fetchApp.connections.removeFolder(folder); }, root);
      await page.evaluate(() => localStorage.removeItem('qa-audio-limit'));
      await page.waitForFunction(() => document.querySelector('.strip').hidden && window.__proto1State.sounds.length === 300, null, { timeout: 30_000 });
      pass('C8: sounds of unknown length are absent from 0.5초 이하 and from its count');
    },

    async searchLog() {
      setPlan(async () => plan(LASER));
      setPhrase(validPhrase);
      await page.locator('.chatbtn').click();
      await page.locator('[aria-label="새 대화"]').click();
      await page.locator('.compose-input').fill('기록할 레이저');
      await page.locator('.compose-input').press('Enter');
      await page.waitForFunction(() => document.querySelector('.ans .crow') && !document.querySelector('.ans .dots'), null, { timeout: 30_000 });
      const name = await page.locator('.ans .crow .fname').first().innerText();
      await page.locator('.ans .crow .names').first().click();
      await page.keyboard.press('Escape');
      await search.fill(name.replace(/\.\w+$/, ''));
      const row = page.locator('.list .row', { hasText: name }).first();
      await row.hover();
      await page.waitForFunction(() => !document.querySelector('.list .row').classList.contains('wait'));
      await nextDrag(profile, () => row.dispatchEvent('dragstart'));
      await row.locator('.mb').click();
      await page.getByRole('menuitem', { name: '모음에 추가' }).click();
      await page.locator('.menu.sub button', { hasText: '새 모음' }).click();
      await page.locator('.nav-new').fill('기록 모음');
      await page.locator('.nav-new').press('Enter');
      await page.locator('.nav-c', { hasText: '기록 모음' }).waitFor();
      await search.fill('');
      await page.locator('.chatbtn').click();
      // Handlers run in order, so every line is in the file once this later call returns.
      await page.evaluate(() => window.fetchApp.collections.load());
      const entries = (await fs.readFile(path.join(profile, 'search-log.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const asked = entries.findLast((entry) => entry.event === 'search' && entry.request === '기록할 레이저');
      assert(asked, 'the search is in the log');
      for (const field of ['timestamp', 'plan', 'conditions', 'results', 'is_low_score', 'analysis', 'plan_ms', 'phrase_ms']) assert(field in asked, field);
      assert.equal(asked.results.length, 10, 'the top ten paths and scores');
      for (const event of ['play', 'drag', 'collection']) {
        const line = entries.find((entry) => entry.event === event && entry.path.endsWith(name));
        assert.equal(line?.answerId, asked.answerId, `${event} carries the answer's number`);
      }
      assert.equal(relay.calls.some((call) => JSON.stringify(call).includes('search-log')), false);
      pass(`C9: with PROTO1_SEARCH_LOG=1 search-log.jsonl holds the search and its play, drag and collection lines under answer ${asked.answerId}`);
    },
  };
}

/** The temp library: second journey, on a profile that started empty and with the log switched off. */
export function listChecks({ page, pass, shot, profile, setPhrase }) {
  const row = (name) => page.locator('.list .row', { hasText: name });
  const search = page.getByRole('searchbox', { name: '파일 이름 검색' });

  return {
    async lengths() {
      const lengths = await Promise.all(['groove_one.wav', 'drone_long.wav', 'drone_longest.wav', 'broken_sound.wav'].map((name) => row(name).locator('.dur').innerText()));
      assert.deepEqual(lengths, ['1.36초', '1:12', '30:00', '읽지 못함']);
      await shot(page, 'c8-lengths');
      pass('15.2: lengths keep two decimals under a minute and read 1:12 and 30:00 above it; a sound that could not be read says 읽지 못함');
    },

    async playerClock() {
      for (const [name, total] of [['groove_one.wav', '1.4초'], ['pad_two.wav', '2초'], ['tick_short.wav', '0.1초']]) {
        await row(name).locator('.names').click();
        await page.waitForFunction(([file, wanted]) => document.querySelector('.player .fname').textContent === file
          && document.querySelector('.player .time span').textContent.trim() === `/ ${wanted}`, [name, total], { timeout: 15_000 });
        assert.match(await page.locator('.player .time b').innerText(), /^\d+(\.\d)?$/, 'the position has at most one decimal');
        await shot(page, `c8-player-${total.replace('초', 's')}`);
      }
      await page.keyboard.press('Escape');
      pass('C8: the player shows 1.36 as 1.4초, 2.00 as 2초 and 0.01 as 0.1초');
    },

    async readFailures() {
      await row('broken_sound.wav').locator('.names').click();
      await page.locator('.strip .err', { hasText: '소리를 재생하지 못했습니다.' }).waitFor({ timeout: 15_000 });
      await shot(page, 'c8-play-failure');
      await row('broken_copy.ogg').hover();
      await page.locator('.strip .err', { hasText: '소리 파일을 읽지 못했습니다.' }).waitFor({ timeout: 15_000 });
      assert.doesNotMatch(await page.locator('.strip').innerText(), /decode|WAV 사본/i);
      await page.mouse.move(300, 12);
      pass('15.2: the decoder\'s English stays off the screen, and a file with no copy says 소리 파일을 읽지 못했습니다.');
    },

    async collectionTitle() {
      await page.locator('[aria-label="새 모음"]').click();
      await page.locator('.nav-new').fill('제목 확인 모음');
      await page.locator('.nav-new').press('Enter');
      const item = page.locator('.nav-c', { hasText: '제목 확인 모음' });
      await item.waitFor();
      await search.fill('rain');
      await item.click();
      assert.equal(await page.locator('.head h1').innerText(), '제목 확인 모음', 'the collection names the screen');
      await search.fill('');
      await page.locator('.nav-i', { hasText: '모든 소리' }).click();
      pass('15.2: a collection opened with a search still on keeps its own name as the title');
    },

    async packs() {
      const shortened = shortPackNames(PACK_NAMES.map((full) => ({ full })));
      assert.deepEqual(shortened, PACK_NAMES, 'shortPackNames leaves them whole');
      await page.locator('.nav-i', { hasText: '팩' }).click();
      await page.locator('.pk').first().waitFor();
      assert.deepEqual((await page.locator('.pk .names .fname').allInnerTexts()).sort(), [...PACK_NAMES, 'Field Kit'].sort(), 'and so does the screen');
      await shot(page, 'c8-pack-names');
      await page.locator('.pk[aria-label="Field Kit"]').click();
      await page.locator('.packtop').waitFor();
      assert.equal(await page.locator('.pfull').count(), 0, 'a name that is already whole is not said twice');
      assert.deepEqual([await row('rain_loop.wav').locator('.pack').innerText(), await row('steps_fast.wav').locator('.pack').innerText()], ['WAV/Ambience', 'WAV/Movement']);
      assert.equal(await row('rain_loop.wav').locator('button.pack').count(), 0, 'a folder path is no link to the pack');
      assert.equal(await row('direct_hit.wav').locator('button.pack').innerText(), 'Field Kit', 'a file directly under the pack keeps its name');
      await shot(page, 'c8-pack-folders');
      pass(`C8: ${PACK_NAMES.length} pack names survive in shortPackNames and on the screen; the pack screen shows folder paths and the pack name for a file directly under it`);
    },

    /** Finding 6, the second half: a period and the length of a pack name are not the sentence's. */
    async packNameInASentence() {
      const message = (facts) => `${facts.packs[0].name} 팩에서 ${facts.count}개를 가져왔어요. 맨 위 소리는 ${facts.first_file}예요.`;
      setPhrase((facts) => ({ message: message(facts) }));
      await page.locator('.nav-i', { hasText: '모든 소리' }).click();
      await page.locator('.chatbtn').click();
      await page.locator('.compose-input').fill('drone 소리');
      await page.locator('.compose-input').press('Enter');
      await page.waitForFunction(() => document.querySelector('.ans .say') && !document.querySelector('.ans .dots'), null, { timeout: 30_000 });
      const first = await page.locator('.ans .crow .fname').first().innerText();
      const count = await page.locator('.ans .crow').count();
      assert.deepEqual(await page.locator('.ans .say').allInnerTexts(), [`Essential Techno Vol. 2 팩에서 ${count}개를 가져왔어요. 맨 위 소리는 ${first}예요.`], 'the sentence stands');
      setPhrase(validPhrase);
      await page.locator('[aria-label="새 대화"]').click();
      await page.locator('.chatbtn').click();
      pass('finding 6: a pack name with a period in it, Essential Techno Vol. 2, no longer fails the sentence check');
    },

    async logStaysOff() {
      await page.locator('.chatbtn').click();
      await page.locator('.compose-input').fill('기록하지 않을 소리');
      await page.locator('.compose-input').press('Enter');
      await page.waitForFunction(() => document.querySelector('.ans .crow') && !document.querySelector('.ans .dots'), null, { timeout: 30_000 });
      await page.locator('.ans .crow .names').first().click();
      await page.keyboard.press('Escape');
      // Handlers run in order: any line these clicks caused would already be in the file.
      await page.evaluate(() => window.fetchApp.collections.load());
      await assert.rejects(fs.access(path.join(profile, 'search-log.jsonl')), { code: 'ENOENT' });
      pass('C9: with PROTO1_SEARCH_LOG unset a search and a played sound write no search-log.jsonl');
    },
  };
}

export async function oldStringsChecks({ pass }) {
  const lines = await sourceLines(path.join(appDir, 'src'));
  const found = lines.flatMap(({ at, line }) => OLD_STRINGS.filter((old) => line.includes(old)).map((old) => `${at}: ${old}`));
  assert.deepEqual(found, [], 'old strings in code');
  pass(`C8: none of the ${OLD_STRINGS.length} old strings of spec 8, 5 and 15.2 is left in the code under src/ (comments are not screen text)`);
}
