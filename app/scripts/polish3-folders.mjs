// Folders after the third polish: the row before the scan ends, a failed read on its row, the path beside the bar,
// the refresh icon and the three window widths. Runs on temp copies only; the temp folders go when the run ends.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const SMALL_SOUNDS = 1200;
const SPARSE_FILES = 60;
const SPARSE_BYTES = 95_000_000;
const ROW_DEADLINE_MS = 1000;
const WIDTHS = [[1100, 760], [720, 760], [480, 728]];

/** Mono 16-bit PCM; a different frequency makes a file its own sound. */
export function wav(seconds, frequency = 440) {
  const rate = 8000;
  const samples = Math.round(seconds * rate);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples * 2, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * index / rate) * 9000), 44 + index * 2);
  return bytes;
}

/** Many small sounds, and sparse files that cost no disk but take seconds to hash, so the scan is still running when the row must show. */
export async function largeFolder(base, name) {
  const root = path.join(base, name);
  await fs.mkdir(root);
  await Promise.all(Array.from({ length: SMALL_SOUNDS }, (_, index) => fs.writeFile(path.join(root, `small_${index}.wav`), wav(0.02, 200 + index))));
  await Promise.all(Array.from({ length: SPARSE_FILES }, async (_, index) => {
    const file = await fs.open(path.join(root, `sparse_${index}.wav`), 'w');
    await file.write(`sparse ${index}`);
    await file.truncate(SPARSE_BYTES);
    await file.close();
  }));
  return root;
}

export function folderChecks({ page, pass, shot, resize, base, wavs }) {
  const settings = () => page.locator('.nav-i', { hasText: '설정' }).click();
  const row = (name) => page.locator('.li', { hasText: name });
  const sideways = () => page.evaluate(() => ['.library', '.strip', '.top', '.set', '.li', '.mid-b'].flatMap((selector) => [...document.querySelectorAll(selector)]
    .filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => `${selector}: ${element.scrollWidth} over ${element.clientWidth}`)));
  const remove = (root) => page.evaluate(async (folder) => { await window.fetchApp.connections.removeFolder(folder); }, root);
  const allSounds = () => page.waitForFunction(() => window.__proto1State.sounds.length === 300, null, { timeout: 30_000 });

  return {
    async rowAtOnce() {
      const root = await largeFolder(base, 'Large Library');
      await settings();
      await page.evaluate(() => localStorage.setItem('qa-audio-limit', '0'));
      const shownAfter = await page.evaluate((folder) => new Promise((resolve) => {
        const name = folder.split('/').pop();
        const began = performance.now();
        const seen = new MutationObserver(() => {
          if (![...document.querySelectorAll('.li')].some((item) => item.textContent.includes(name))) return;
          seen.disconnect();
          resolve(performance.now() - began);
        });
        seen.observe(document.querySelector('.library'), { childList: true, subtree: true });
        void window.fetchApp.connections.connectFolder(folder);
      }), root);
      assert(shownAfter < ROW_DEADLINE_MS, `the row took ${Math.round(shownAfter)}ms`);
      const checking = row('Large Library');
      assert.equal(await checking.locator('.st').innerText(), '폴더 확인 중', 'the scan is still running, so this was no cached answer');
      assert.equal(await checking.locator('.pack').count(), 0, 'no 소리 0개 on the row');
      assert.equal(await page.locator('.strip').innerText(), '폴더 확인 중', 'no 0 on the strip');
      assert.equal(await page.locator('.strip .num').count(), 0);
      await shot(page, 'c6-folder-checking');

      await page.locator('.strip .mid').waitFor({ timeout: 60_000 });
      const count = (SMALL_SOUNDS + SPARSE_FILES).toLocaleString('ko-KR');
      assert.equal(await page.locator('.strip .num').innerText(), `0 / ${count}`, 'the bar counts with a comma');
      assert.match(await checking.locator('.pack').innerText(), new RegExp(`소리 ${count}개`));
      await page.waitForFunction(() => document.querySelector('.li .st .num')?.textContent.includes(','), null, { timeout: 15_000 });

      for (const [width, height] of WIDTHS) {
        await resize(width, height);
        assert.deepEqual(await sideways(), [], `${width}px`);
        await shot(page, `c6-strip-${width}`);
        const place = page.locator('.strip .mid');
        const name = await place.textContent();
        assert.equal(name, width < 720 ? 'Large Library' : root, `${width}px: the path beside the bar`);
        assert.equal(await place.locator('.mid-b').innerText(), 'Large Library', `${width}px: the folder name stays whole`);
      }
      await resize(1100, 760);
      await page.locator('.strip .mid').hover();
      await page.locator('.tip.on', { hasText: root }).waitFor();
      await shot(page, 'c6-strip-tooltip');
      await page.mouse.move(300, 12);
      await remove(root);
      await page.evaluate(() => localStorage.removeItem('qa-audio-limit'));
      await page.waitForFunction(() => document.querySelector('.strip').hidden, null, { timeout: 30_000 });
      await allSounds();
      pass(`C6: a folder of ${count} sounds has its row ${Math.round(shownAfter)}ms after connecting, says 폴더 확인 중 with no 0, then shows its path beside the bar at 1100, 720 and 480 with the tooltip`);
    },

    async failedRead() {
      const root = await wavs('unreadable', 3);
      await page.evaluate(async (folder) => { await window.fetchApp.connections.connectFolder(folder); }, root);
      await page.waitForFunction(() => document.querySelector('.strip').hidden, null, { timeout: 30_000 });
      await fs.chmod(root, 0o000);
      const folder = row('unreadable');
      try {
        await folder.hover();
        await folder.getByRole('button', { name: '다시 확인' }).click();
        await folder.locator('.bad', { hasText: '폴더를 읽을 수 없어 확인을 멈췄습니다' }).waitFor({ timeout: 15_000 });
        assert((await folder.locator('.bad').innerText()).includes('unreadable'), 'the reason names the folder');
        await shot(page, 'c6-failed-read');
        for (const [width, height] of WIDTHS) {
          await resize(width, height);
          assert.deepEqual(await sideways(), [], `${width}px with a long reason`);
          await shot(page, `c6-settings-${width}`);
        }
        await resize(1100, 760);
      } finally {
        await fs.chmod(root, 0o755);
      }
      await folder.hover();
      await folder.getByRole('button', { name: '다시 확인' }).click();
      await folder.locator('.st', { hasText: '분석 완료' }).waitFor({ timeout: 15_000 });
      await remove(root);
      await allSounds();
      pass('C6: a failed read shows its reason on the row at all three widths, and 다시 확인 brings the folder back');
    },

    async refreshIcon() {
      const first = page.locator('.li').first();
      const text = await first.locator('.fname').innerText();
      assert.match(text, /^~\//, `the home folder reads ~: ${text}`);
      assert.equal(await first.locator('.btn').count(), 0, 'no text button on the row');
      assert.equal(await first.locator('.recheck').evaluate((button) => getComputedStyle(button).opacity), '0', 'it waits for the row');
      await first.hover();
      const icon = first.locator('.recheck');
      assert.equal(await icon.evaluate((button) => getComputedStyle(button).opacity), '1');
      assert.equal(await icon.evaluate((button) => getComputedStyle(button).borderTopWidth), '0px', 'no outline');
      await icon.hover();
      await page.locator('.tip.on', { hasText: '다시 확인' }).waitFor();
      await shot(page, 'c6-refresh-tooltip');
      const refresh = await icon.boundingBox();
      const unlink = await first.locator('.unlink').boundingBox();
      assert(refresh.x + refresh.width <= unlink.x, 'beside the unlink icon, on its left');
      await page.mouse.move(300, 12);
      await page.keyboard.press('Tab');
      pass('C6: the refresh line icon replaces the button, shows on the row, sits left of unlink and has its tooltip');
    },

    async longPathKeepsItsName() {
      const root = await wavs(path.join('a very long folder name that goes on', 'and on through several levels of nesting', 'until it cannot fit', 'Last Folder'), 1);
      await page.evaluate(async (folder) => { await window.fetchApp.connections.connectFolder(folder); }, root);
      const folder = row('Last Folder');
      await folder.waitFor();
      await resize(720, 760);
      const shown = await folder.locator('.mid').evaluate((mid) => {
        const [head, tail] = mid.children;
        return { head: head.scrollWidth > head.clientWidth, tail: tail.scrollWidth <= tail.clientWidth, name: tail.textContent };
      });
      assert.deepEqual(shown, { head: true, tail: true, name: 'Last Folder' }, 'the middle of the path gives way');
      await shot(page, 'c8-settings-long-path');
      await resize(1100, 760);
      await remove(root);
      await allSounds();
      // The narrow windows closed the menu; the next check starts from it.
      await page.locator('.top .ib').first().click();
      await page.locator('.nav').waitFor();
      pass('15.2: a long folder path shrinks in the middle and keeps the folder name');
    },
  };
}
