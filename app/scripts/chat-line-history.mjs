// What an answer said, in order, while it waited. Written for the report of a sentence that came and went on "뿅뿅":
// run alone it records every path with the fake relay, on whichever build this folder holds, and writes them down.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceDir, launchHidden, startFakeRelay } from './v3-harness.mjs';

const WORD = '뿅뿅';
const LINE = '3개를 가져왔어요.';
const REFERENCE = 'laser2.ogg';
const SLOW_MS = 1500;
const UNAVAILABLE = '지금은 소리를 찾지 못했어요. 다시 시도해 주세요.';
const UNREAD = '요청을 읽지 못해 넣어 주신 소리와 비슷한 소리로 골랐어요. 다시 시도하면 요청까지 반영해 찾아볼게요.';
const plan = { english_queries: ['a sci-fi laser gun shot'], name_keywords: [], min_duration_seconds: null, max_duration_seconds: null, explanation: '탄력 있게 튀는 만화풍 팝 소리를 가져왔어요.' };
const timedOut = { status: 504, body: { error: 'TIMEOUT' } };
const gateway = { status: 504, raw: '<html><body><h1>504 Gateway Time-out</h1></body></html>' };

export const cases = [
  { name: 'report: reference, model read from disk', reference: true, model: 'cached' },
  { name: 'no reference, model read from disk', model: 'cached' },
  { name: 'slow plan', delay: SLOW_MS },
  { name: 'relay 504 with its own error', reply: timedOut },
  { name: 'proxy 504 page', reply: gateway },
  { name: 'slow plan, then 504', delay: SLOW_MS, reply: gateway },
  { name: 'model really downloading', model: 'fetching' },
  { name: 'text model fails', model: 'text-fail' },
  { name: 'reference, relay 504', reference: true, reply: timedOut },
];

async function history(page, { reference, model }) {
  await page.locator('[aria-label="새 대화"]').click();
  await page.evaluate((mode) => {
    if (mode) localStorage.setItem('qa-model', mode); else localStorage.removeItem('qa-model');
    window.qaLines = [];
    const note = () => {
      const answer = [...document.querySelectorAll('.ans')].at(-1);
      const text = answer && [...answer.querySelectorAll('.say')].map((say) => say.textContent).join(' | ');
      if (text && window.qaLines.at(-1)?.text !== text) window.qaLines.push({ text, warns: Boolean(answer.querySelector('.say.err')) });
    };
    window.qaWatch?.disconnect();
    window.qaWatch = new MutationObserver(note);
    window.qaWatch.observe(document.querySelector('.msgs'), { childList: true, subtree: true, characterData: true });
  }, model);
  const input = page.locator('.compose-input');
  await input.fill(WORD);
  if (reference) {
    const id = await page.locator('.list .row', { hasText: REFERENCE }).first().getAttribute('data-id');
    await page.evaluate((sound) => {
      const transfer = new DataTransfer();
      transfer.setData('application/x-proto1-sound', sound);
      document.querySelector('.compose').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, id);
    await page.locator('.attach .fname').waitFor({ timeout: 30_000 });
  }
  await input.press('Enter');
  await page.waitForFunction(() => document.querySelector('.ans') && !document.querySelector('.ans .dots'), null, { timeout: 30_000 });
  await page.evaluate(() => { localStorage.removeItem('qa-model'); window.qaWatch.disconnect(); });
  return page.evaluate(() => window.qaLines);
}

/** Each case on the page's chat, with the relay answering as the case says. */
export async function lineHistories(page, relay, setReply) {
  await page.locator('.list .row', { hasText: REFERENCE }).first().waitFor();
  const results = [];
  for (const item of cases) {
    setReply(async () => {
      if (item.delay) await new Promise((resolve) => { setTimeout(resolve, item.delay); });
      return item.reply ?? plan;
    });
    const sent = relay.calls.length;
    const lines = await history(page, item);
    results.push({ name: item.name, lines, requests: relay.calls.length - sent });
  }
  return results;
}

/** The fixed build: a line that shows while waiting stays true, and a final sentence never changes. */
export function checkHistories(results) {
  const of = (name) => results.find((item) => item.name === name).lines;
  for (const { name, lines, requests } of results) {
    assert.equal(requests, 1, `${name}: one request reached the relay`);
    const stopped = lines.findIndex(({ text }) => text.includes(UNAVAILABLE));
    assert(stopped < 0 || stopped === lines.length - 1, `${name}: the unavailable sentence is final: ${JSON.stringify(lines)}`);
  }
  assert.deepEqual(of(cases[0].name).map(({ text }) => text), [LINE], 'the report: only the answer shows');
  assert.deepEqual(of(cases[1].name).map(({ text }) => text), [LINE]);
  assert.deepEqual(of('slow plan').map(({ text }) => text), [LINE]);
  assert.deepEqual(of('model really downloading').map(({ text }) => text), [LINE], 'the waiting lines cover a real download');
  for (const name of ['relay 504 with its own error', 'proxy 504 page', 'slow plan, then 504', 'text model fails']) {
    assert.equal(of(name).length, 1, `${name}: ${JSON.stringify(of(name))}`);
    assert(of(name)[0].warns && of(name)[0].text.includes(UNAVAILABLE), name);
  }
  assert.deepEqual(of('reference, relay 504'), [{ text: UNREAD, warns: false }], 'a failed reading of the words is no warning when the reference answered');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let reply;
  const relay = await startFakeRelay((input) => reply(input));
  const { page, close } = await launchHidden({ relayUrl: relay.url, seeded: true });
  try {
    await page.locator('.chatbtn').click();
    const results = await lineHistories(page, relay, (next) => { reply = next; });
    await fs.writeFile(path.join(await evidenceDir('ppyong'), `${process.env.LINE_HISTORY_NAME ?? 'lines'}.json`), JSON.stringify(results, null, 2));
    for (const { name, lines } of results) console.log(`${name}: ${lines.map(({ text, warns }) => `${warns ? '[warning] ' : ''}${text}`).join('  ->  ')}`);
    if (process.env.LINE_HISTORY_NAME !== 'base') {
      checkHistories(results);
      console.log('PASS chat-line-history');
    }
  } finally {
    await close();
    await relay.close();
  }
}
