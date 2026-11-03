// Moving around: titles and counts, back and forward, length inputs, the submenu and the pack screen.
// allow: SIZE_OK - One journey through one page: the checks share its helpers and hand its state to each other.
import assert from 'node:assert/strict';

export function navChecks({ page, pass, shot, pick, away }) {
  const search = page.getByRole('searchbox', { name: '파일 이름 검색' });
  const back = page.locator('[aria-label="뒤로"]');
  const forward = page.locator('[aria-label="앞으로"]');
  const list = page.locator('.list');
  const title = page.locator('.head h1');
  const count = page.locator('.head .count');
  const menuItem = (name) => page.locator('.nav-i', { hasText: name });
  const onChip = page.locator('.filters .chip.on');
  const home = () => menuItem('모든 소리').click();
  const scrollTop = () => list.evaluate((element) => element.scrollTop);
  const scrollTo = async (top) => {
    await list.evaluate((element, value) => { element.scrollTop = value; }, top);
    await page.locator(`.list .row[style*="top:${top}px"]`).waitFor();
  };
  const collection = async (name) => {
    await page.locator('[aria-label="새 모음"]').click();
    await page.locator('.nav-new').fill(name);
    await page.locator('.nav-new').press('Enter');
    await page.locator('.nav-c', { hasText: name }).waitFor();
  };

  return {
    async titles() {
      await home();
      assert.deepEqual([await title.innerText(), await count.innerText()], ['모든 소리', '소리 300개'], 'no conditions');
      await search.fill('laser');
      await search.press('Enter');
      await title.getByText('"laser" 검색 결과').waitFor();
      const found = Number(await page.locator('.head .count .result').innerText());
      assert.equal(await count.innerText(), `결과 ${found}개 / 전체 300개`);
      assert.equal(await list.evaluate((element) => element.scrollHeight / 52), found, 'the count is the list');
      await search.fill('');
      await search.press('Enter');
      await pick('길이', '2초 이상');
      assert.equal(await title.innerText(), '모든 소리', 'a filter keeps the title');
      assert.match(await count.innerText(), /^결과 \d+개 \/ 전체 300개$/);
      await search.fill('zzzz');
      await title.getByText('"zzzz" 검색 결과').waitFor();
      assert.equal(await count.innerText(), '결과 0개 / 전체 300개');
      assert.equal(await page.locator('.none p').innerText(), '"zzzz" 검색 결과가 없습니다.');
      assert.equal(await page.locator('.clear-all').count(), 0, 'no clear all in the chips with no results');
      await page.getByRole('button', { name: '검색 지우기' }).click();
      await page.locator('.clear-all').click();
      assert.equal(await onChip.count(), 0);
      await menuItem('즐겨찾기').click();
      assert.equal(await title.innerText(), '즐겨찾기');
      assert.equal(await page.locator('.none p').innerText(), '즐겨찾기한 소리가 없습니다.');
      await menuItem('팩').click();
      assert.deepEqual([await title.innerText(), await count.innerText()], ['팩', '팩 9개']);
      await collection('빈 모음');
      await page.locator('.nav-c', { hasText: '빈 모음' }).click();
      assert.equal(await title.innerText(), '빈 모음');
      assert.equal(await page.locator('.none p').innerText(), '모음이 비어 있습니다.');
      await home();
      pass('titles and counts: all sounds, search, filter, favorites, packs, a collection, and their empty sentences; clear all hides at 0');
    },

    async history() {
      await pick('길이', '0.5초 이하');
      await home();
      await scrollTo(1040);
      await page.locator('.list .row[style*="top:1040px"] .names').click();
      const selected = await page.locator('.list .row.sel').getAttribute('data-id');
      await page.keyboard.press('Escape');
      await menuItem('설정').click();
      await page.locator('.set').waitFor();
      await back.click();
      await page.locator('.list .row.sel').waitFor();
      assert.equal(await scrollTop(), 1040, 'the place in the list comes back after the list is built');
      assert.equal(await page.locator('.list .row.sel').getAttribute('data-id'), selected, 'the selected row comes back');
      assert.equal(await onChip.count(), 1, 'the filter comes back');
      await forward.click();
      await page.locator('.set').waitFor();
      await back.click();
      await page.locator('.list .row').first().waitFor();

      await search.focus();
      await page.keyboard.type('laser', { delay: 30 });
      await search.press('Enter');
      await back.click();
      assert.equal(await search.inputValue(), '', 'a word typed in one go is one step');
      await forward.click();
      assert.equal(await search.inputValue(), 'laser');
      await back.click();
      await page.evaluate(() => {
        const next = document.querySelector('[aria-label="앞으로"]');
        window.qaGrouped = new Promise((resolve) => {
          let typed;
          document.querySelector('.search-input').addEventListener('input', () => { typed = performance.now(); });
          new MutationObserver(() => { if (next.disabled) resolve(performance.now() - typed); }).observe(next, { attributes: true });
        });
      });
      await search.focus();
      await page.keyboard.type('door');
      const pause = await page.evaluate(() => window.qaGrouped);
      assert(pause >= 680 && pause < 1200, `a pause of 700ms ends the step: ${pause}`);
      assert.equal(await forward.isDisabled(), true, 'a new step ends the forward list');
      await back.click();
      assert.equal(await search.inputValue(), '');

      await onChip.locator('.chip-x').click();
      assert.equal(await onChip.count(), 0);
      await back.click();
      assert.equal(await onChip.count(), 1, 'back undoes a filter');
      await forward.click();
      assert.equal(await onChip.count(), 0, 'forward does it again');
      pass(`back and forward: screen, scroll, selection, filter, and search grouped by Enter and by a ${Math.round(pause)}ms pause`);
    },

    async deletedCollection() {
      await pick('길이', '2초 이상');
      await collection('사라질 모음');
      await page.locator('.nav-c', { hasText: '사라질 모음' }).click();
      assert.equal(await title.innerText(), '사라질 모음');
      await page.locator('.nav-i', { hasText: '설정' }).click();
      await page.evaluate(() => {
        const state = window.__proto1State;
        state.collections = { ...state.collections, collections: state.collections.collections.filter((item) => item.name !== '사라질 모음') };
        window.__proto1Render();
      });
      await back.click();
      await page.locator('.filters .chip.on', { hasText: '2초 이상' }).waitFor();
      assert.equal(await title.innerText(), '모든 소리', 'the gone screen is skipped');
      await forward.click();
      await page.locator('.set').waitFor();
      assert.equal(await forward.isDisabled(), true);
      await back.click();
      await page.locator('.clear-all').click();
      pass('a deleted collection is skipped going back and going forward');
    },

    async lengths() {
      const openLength = async () => {
        const active = page.locator('.filters .chip.on .chip-b');
        await (await active.count() ? active : page.locator('.filters .chip', { hasText: '길이' })).click();
      };
      const fields = () => [page.getByRole('textbox', { name: '최소(초)' }), page.getByRole('textbox', { name: '최대(초)' })];
      const durations = () => page.locator('.list .row .dur').allInnerTexts().then((texts) => texts.map((text) => parseFloat(text)));
      await openLength();
      const [low, high] = fields();
      await low.fill('0.2');
      await high.fill('1.5');
      await high.press('Enter');
      await page.locator('.filters .chip.on', { hasText: '0.2-1.5초' }).waitFor();
      assert((await durations()).every((value) => value >= 0.2 && value <= 1.5), 'kept exactly, with no margin');
      await openLength();
      assert.deepEqual([await fields()[0].inputValue(), await fields()[1].inputValue()], ['0.2', '1.5'], 'the box shows the range');
      await fields()[0].fill('');
      await fields()[1].fill('0,5');
      await page.locator('.pop .primary').click();
      await page.locator('.filters .chip.on', { hasText: '0.5초 이하' }).waitFor();
      await openLength();
      await fields()[0].fill('2');
      await fields()[1].fill('');
      await page.locator('.pop .primary').click();
      await page.locator('.filters .chip.on', { hasText: '2초 이상' }).waitFor();
      await openLength();
      await fields()[0].fill('3');
      await fields()[1].fill('1');
      await page.locator('.pop .primary').click();
      assert.equal(await fields()[0].getAttribute('aria-invalid'), '', 'crossed values are marked');
      assert.equal(await page.locator('.pop').isVisible(), true, 'and nothing is applied');
      await fields()[0].fill('abc');
      await fields()[1].fill('');
      await page.locator('.pop .primary').click();
      assert.equal(await fields()[0].getAttribute('aria-invalid'), '');
      await page.keyboard.press('Escape');
      await page.locator('.filters .chip.on .chip-x').click();
      assert.equal(await onChip.count(), 0);
      pass('length inputs: both ends, one end, a decimal comma, Enter and 적용, exact range on the chip, bad values refused');
    },

    async submenu() {
      for (const name of ['첫째 모음', '둘째 모음', '셋째 모음']) await collection(name);
      await scrollTo(0).catch(() => {});
      const row = page.locator('.list .row').nth(2);
      const openMenu = async () => { await row.locator('.mb').click(); await page.locator('.menu:not(.sub)').waitFor(); };
      const owner = page.getByRole('menuitem', { name: '모음에 추가' });
      const sub = page.locator('.menu.sub');
      await openMenu();
      await page.evaluate(() => {
        const item = [...document.querySelectorAll('.menu button')].find((button) => button.textContent.includes('모음에 추가'));
        window.qaOpened = new Promise((resolve) => {
          let from;
          item.addEventListener('pointerenter', () => { from = performance.now(); });
          new MutationObserver(() => { if (document.querySelector('.menu.sub')) resolve(performance.now() - from); }).observe(document.querySelector('#app'), { childList: true });
        });
      });
      await owner.hover();
      const opened = await page.evaluate(() => window.qaOpened);
      assert(opened >= 185 && opened < 500, `hover opens after 200ms: ${opened}`);
      await shot(page, 'submenu');

      const menuBox = await page.locator('.menu:not(.sub)').boundingBox();
      const subBox = await sub.boundingBox();
      assert(subBox.x + subBox.width <= menuBox.x, 'no room on the right: it opens on the left');
      const box = await owner.boundingBox();
      const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const goal = { x: subBox.x + subBox.width - 2, y: subBox.y + subBox.height - 8 };
      const along = (share) => [start.x + (goal.x - start.x) * share, start.y + (goal.y - start.y) * share];
      await page.mouse.move(...along(0));
      const crossing = page.locator('.menu:not(.sub) button', { hasText: 'Finder' });
      const crossingBox = await crossing.boundingBox();
      const share = (crossingBox.y + 4 - start.y) / (goal.y - start.y);
      assert(share > 0 && share < 1, 'the way to the submenu crosses the next item');
      await page.mouse.move(...along(share), { steps: 6 });
      assert.equal(await sub.isVisible(), true, 'the submenu waits on the way');
      await page.mouse.move(...along(1), { steps: 6 });
      await sub.hover();
      assert.equal(await sub.isVisible(), true, 'and is there on arrival');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      await openMenu();
      await owner.hover();
      await sub.waitFor();
      await page.mouse.move(...along(0));
      await page.evaluate(() => {
        const item = [...document.querySelectorAll('.menu button')].find((button) => button.textContent.includes('모음에 추가'));
        window.qaClosed = new Promise((resolve) => {
          let from;
          item.addEventListener('pointerleave', () => { from = performance.now(); });
          new MutationObserver(() => { if (!document.querySelector('.menu.sub')) resolve(performance.now() - from); }).observe(document.querySelector('#app'), { childList: true });
        });
      });
      await page.mouse.move(...along(share), { steps: 6 });
      const closed = await page.evaluate(() => window.qaClosed);
      assert(closed >= 250 && closed < 600, `the way lasts 300ms at most: ${closed}`);
      await page.keyboard.press('Escape');

      await openMenu();
      await owner.click();
      assert.equal(await sub.isVisible(), true, 'a click opens at once');
      await page.locator('.menu.sub button', { hasText: '둘째 모음' }).click();
      await page.locator('.menu').first().waitFor({ state: 'detached' });
      await page.locator('.nav-c', { hasText: '둘째 모음' }).click();
      await page.locator('.list .row').first().waitFor();
      assert.equal(await count.innerText(), '소리 1개', 'the sound went in');
      await home();
      await away();
      pass(`submenu: hover opens after ${Math.round(opened)}ms, a click at once, the way through the next item holds ${Math.round(closed)}ms, no room flips it left`);
    },

    async packScreen() {
      const head = page.locator('.packtop');
      await pick('길이', '0.5초 이하');
      await scrollTo(520);
      const row = page.locator('.list .row[style*="top:520px"]');
      const full = await row.locator('.tile').getAttribute('aria-label');
      await row.locator('.tile').click();
      await head.waitFor();
      assert.equal(await page.locator('.pfull').innerText(), full, 'the folder name beside the short name');
      assert.equal(await page.locator('.filters .chip', { hasText: /^팩/ }).count(), 0, 'no pack chip inside a pack');
      assert.equal(await page.locator('.filters .sort').innerText(), '이름순', 'name order by default');
      assert.equal(await page.locator('.nav-i.on').innerText(), '팩', 'the menu stays on 팩');
      assert.match(await page.locator('.pstat').innerText(), /^소리 \d+개, 합계 /);
      await shot(page, 'pack-screen');
      await back.click();
      await page.locator('.filters .chip.on', { hasText: '0.5초 이하' }).waitFor();
      assert.equal(await scrollTop(), 520, 'back: the list, its filter and its place');

      await page.locator('.list .row').first().locator('button.pack').click();
      await head.waitFor();
      await back.click();
      await menuItem('팩').click();
      await page.locator('.pk').first().click();
      await head.waitFor();
      await back.click();
      await page.locator('.packs').waitFor();
      await home();
      await page.locator('.list .row').first().locator('.names').click();
      await page.locator('.player button.pack').click();
      await head.waitFor();
      await page.keyboard.press('Escape');
      await back.click();
      await page.locator('.clear-all').click();
      pass('pack screen: from a tile, a pack name, a card and the player, and back returns the search, filter and place');
    },
  };
}
