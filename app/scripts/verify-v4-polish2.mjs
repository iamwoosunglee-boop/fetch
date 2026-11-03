// The Splice polish on the built Mac app: real clicks and keys in hidden windows, a fake relay and no model.
// Each group of checks leaves the screen as it found it: all sounds, no filters, menu open, panel closed.
import path from 'node:path';
import { evidenceDir, launchHidden, resizeContent, startFakeRelay } from './v3-harness.mjs';
import { answerPlan, chatChecks } from './polish2-chat.mjs';
import { lookChecks } from './polish2-look.mjs';
import { navChecks } from './polish2-nav.mjs';
import { packChecks } from './polish2-packs.mjs';
import { playChecks } from './polish2-play.mjs';
import { noteChecks, reviewChecks, reviewOrder } from './polish2-review.mjs';

const out = await evidenceDir('polish2');
const pass = (message) => console.log(`PASS ${message}`);
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });

let reply = async () => answerPlan;
const relay = await startFakeRelay((input) => reply(input));
const setReply = (next) => { reply = next; };

async function open(profile) {
  const launched = await launchHidden({ relayUrl: relay.url, testDrag: true, ...(profile ? { profile } : { seeded: true }) });
  await launched.page.goto(`${launched.page.url().split('?')[0]}?proto1-test-state=1`);
  await launched.page.locator('.list .row').first().waitFor();
  await launched.page.locator('#splash').waitFor({ state: 'detached' });
  return launched;
}

const journey = (launched) => {
  const { app, page, profile } = launched;
  const parts = {
    page, pass, shot, relay, setReply, profile,
    resize: (width, height = 760) => resizeContent(app, page, width, height),
    away: () => page.mouse.move(300, 12),
    pick: async (chip, option) => {
      await page.locator('.filters .chip', { hasText: chip }).first().click();
      await page.locator('.pop button', { hasText: option }).first().click();
    },
  };
  return { look: lookChecks(parts), play: playChecks(parts), nav: navChecks(parts), chat: chatChecks(parts), review: reviewChecks(parts), notes: noteChecks(parts) };
};

let launched = await open();
try {
  const { look, play, nav, chat } = journey(launched);
  for (const check of [
    look.surfaces, look.selected, look.chosen, look.motionOfColors, look.rows, look.tooltips, look.pressed, look.widths,
    play.seek, play.played, play.keys, play.selectionApart, play.priority, play.previousAndNext, play.volume,
    nav.titles, nav.history, nav.deletedCollection, nav.lengths, nav.submenu, nav.packScreen,
    chat.marks, chat.sendButton, chat.sentences, chat.rowMenu, chat.queue, chat.sentenceHistories, chat.dragIcon, chat.prepared, chat.narrowDrag, chat.motion,
  ]) await check();

  const { page: firstPage, profile, close } = launched;
  await packChecks({ page: firstPage, relayUrl: relay.url, pass, shot });
  await close();
  launched = await open(profile);
  await journey(launched).play.afterRestart();
  await launched.close();
  launched = await open();
  const { review, notes } = journey(launched);
  for (const name of reviewOrder) await review[name]();
  await notes.notes();
  console.log('PASS verify-v4-polish2');
} catch (error) {
  await shot(launched.page, 'failure').catch(() => {});
  throw error;
} finally {
  await launched.close();
  await relay.close();
}
