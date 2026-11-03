// Lane C of the third polish on the built Mac app: real clicks and keys in hidden windows, temp profiles, a fake relay and no model.
// Screenshots go to .omo/evidence/v4-polish4/screens, which stays out of git. Temp sounds and profiles go when the run ends.
// Usage: npm run build && PROTO1_HIDDEN=1 node scripts/verify-v4-polish3.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectAndAnalyse, evidenceDir, launchHidden, resizeContent, seedProfile, startFakeRelay } from './v3-harness.mjs';
import { chatChecks, LASER, plan, validPhrase } from './polish3-chat.mjs';
import { emptyFindingChecks, findingChecks, listFindingChecks } from './polish3-findings.mjs';
import { folderChecks, wav } from './polish3-folders.mjs';
import { demoChecks, listChecks, oldStringsChecks, writeListLibrary } from './polish3-list.mjs';

const out = await evidenceDir('v4-polish4/screens');
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'proto1-polish3-'));
const pass = (message) => console.log(`PASS ${message}`);
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });

let planReply = async () => plan(LASER);
let phraseReply = validPhrase;
const relay = await startFakeRelay((input) => planReply(input), (facts) => phraseReply(facts));
const setPlan = (next) => { planReply = next; };
const setPhrase = (next) => { phraseReply = next; };

/** A folder of distinct short sounds under the run's temp folder. */
async function wavs(name, count) {
  const root = path.join(base, name);
  await fs.mkdir(root, { recursive: true });
  const stem = path.basename(name);
  await Promise.all(Array.from({ length: count }, (_, index) => fs.writeFile(path.join(root, `${stem}_${index}.wav`), wav(0.3, 500 + index))));
  return root;
}

async function open(profile) {
  const launched = await launchHidden({ relayUrl: relay.url, testDrag: true, profile });
  await launched.page.goto(`${launched.page.url().split('?')[0]}?proto1-test-state=1`);
  await launched.page.locator('.top').waitFor();
  await launched.page.locator('#splash').waitFor({ state: 'detached' });
  return launched;
}

const profiles = { demo: path.join(base, 'demo-profile'), list: path.join(base, 'list-profile'), empty: path.join(base, 'empty-profile') };
await Promise.all(Object.values(profiles).map((profile) => fs.mkdir(profile)));
await seedProfile(profiles.demo);

let launched;
try {
  process.env.PROTO1_SEARCH_LOG = '1';
  launched = await open(profiles.demo);
  delete process.env.PROTO1_SEARCH_LOG;
  const { app, page } = launched;
  await page.locator('.list .row').first().waitFor();
  const parts = { page, pass, shot, relay, setPlan, setPhrase, wavs, base, profile: profiles.demo, resize: (width, height) => resizeContent(app, page, width, height) };
  const demo = demoChecks(parts);
  const folders = folderChecks(parts);
  const chat = chatChecks(parts);
  const findings = findingChecks(parts);
  for (const check of [demo.searchWhileTyping, demo.kindsStartUnclassified, demo.noClassifyScreen, demo.unknownLengths, listFindingChecks(parts).filterEmptiesASearch]) await check();
  await page.locator('.chatbtn').click();
  await page.locator('.compose-input').waitFor();
  for (const check of [chat.sentenceFirst, chat.slowSentence, chat.brokenSentences, chat.previousMessage, chat.noEarlyResults, chat.waitingLines, chat.reducedMotion, chat.failures, chat.rangeAndReason, chat.widths]) await check();
  for (const check of [findings.lengthStaysWithItsSubject, findings.sentenceMovesNothing, findings.failureKeepsTheTab, findings.lengthWords, findings.newRequestIsNoChange, findings.chatSaysWhyNothing]) await check();
  await page.locator('.chatbtn').click();
  for (const check of [folders.rowAtOnce, folders.failedRead, folders.refreshIcon, folders.longPathKeepsItsName]) await check();
  await page.locator('.nav-i', { hasText: '모든 소리' }).click();
  await demo.searchLog();
  await launched.close();

  launched = await open(profiles.list);
  const library = path.join(base, 'List Library');
  const sounds = await writeListLibrary(library);
  await connectAndAnalyse(launched.page, library);
  await launched.page.waitForFunction((count) => document.querySelectorAll('.list .row').length === count, sounds, { timeout: 30_000 });
  const list = listChecks({ page: launched.page, pass, shot, profile: profiles.list, setPhrase });
  for (const check of [list.lengths, list.playerClock, list.readFailures, list.collectionTitle, list.packs, list.packNameInASentence, list.logStaysOff]) await check();
  await launched.close();

  launched = await open(profiles.empty);
  const empty = emptyFindingChecks({ page: launched.page, pass, shot, relay, setPlan, setPhrase, base });
  for (const check of [empty.checkingSaysSo, empty.unknownCountIsNoZero, empty.nothingAnalysed]) await check();
  await oldStringsChecks({ pass });
  console.log('PASS verify-v4-polish3');
} catch (error) {
  await launched?.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await launched?.close();
  await relay.close();
  await fs.rm(base, { recursive: true, force: true, maxRetries: 3 });
}
