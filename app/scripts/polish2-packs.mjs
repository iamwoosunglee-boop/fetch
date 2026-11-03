// Packs on disk: covers, pack.json, what must be refused and how short names stay apart. Runs on its own small library.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appDir, launchHidden, seedProfile } from './v3-harness.mjs';
import { nextDrag, pixels } from './polish2-chat.mjs';

const RED = [255, 0, 0, 255];
const folders = ['kenney-alpha-sounds', 'kenney-beta-sounds', 'kenney-gamma-sounds', 'impact-sounds-1', 'impact-sounds-2', 'twin-one', 'twin-two'];
const facts = { name: 'Alpha Deck', creator: 'QA Studio', license: 'CC0', source: 'https://example.test/alpha' };

/** A solid red PNG drawn by the page, so the fixture needs no stored image. */
const redPng = (page) => page.evaluate(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff0000';
  context.fillRect(0, 0, 8, 8);
  return canvas.toDataURL('image/png').split(',')[1];
});

async function packLibrary(page) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'proto1-packs-'));
  const root = path.join(base, 'Library');
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  const { files } = JSON.parse(await fs.readFile(path.join(appDir, 'web-demo/manifest.json'), 'utf8'));
  const picked = new Map(files.slice(0, folders.length * 3).map((file, index) => [file.path, path.join(root, folders[index % folders.length], path.basename(file.path))]));
  await Promise.all(folders.map((folder) => fs.mkdir(path.join(root, folder), { recursive: true })));
  await Promise.all([...picked].map(([from, to]) => fs.copyFile(path.join(appDir, 'web-demo', from), to)));
  const png = Buffer.from(await redPng(page), 'base64');
  const inPack = (index, name) => path.join(root, folders[index], name);
  await fs.writeFile(inPack(0, 'cover.png'), png);
  await fs.writeFile(inPack(0, 'pack.json'), JSON.stringify(facts));
  await fs.writeFile(inPack(0, 'LICENSE.txt'), 'CC0');
  await fs.writeFile(inPack(1, 'pack.json'), '{ not json');
  await fs.writeFile(path.join(outside, 'cover.png'), png);
  await fs.writeFile(path.join(outside, 'pack.json'), JSON.stringify({ name: 'Taken From Outside' }));
  await fs.symlink(path.join(outside, 'cover.png'), inPack(2, 'cover.png'));
  await fs.symlink(path.join(outside, 'pack.json'), inPack(2, 'pack.json'));
  await fs.writeFile(inPack(3, 'cover.png'), Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]));
  await fs.writeFile(inPack(3, 'pack.json'), JSON.stringify({ name: 'Too Big', padding: 'x'.repeat(70 * 1024) }));
  await fs.writeFile(inPack(4, 'cover.png'), 'not an image at all, only a name that looks like one');
  await fs.writeFile(inPack(5, 'pack.json'), JSON.stringify({ name: 'Twin' }));
  await fs.writeFile(inPack(6, 'pack.json'), JSON.stringify({ name: 'Twin' }));
  // The same file in two packs is one sound in the list, and belongs to the pack it is seen from.
  const shared = [...picked.values()].find((file) => path.dirname(file).endsWith(folders[1]));
  await fs.copyFile(shared, inPack(6, path.basename(shared)));
  return { base, root, picked, shared: path.basename(shared) };
}

/** Two more launches: the pack library, and a library of one sound for the sentence no larger library can reach. */
export async function packChecks({ page, relayUrl, pass, shot }) {
  const { base, root, picked, shared } = await packLibrary(page);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'proto1-v3-profile-'));
  await seedProfile(profile, { root, place: (file) => picked.get(file.path) });
  const packs = await launchHidden({ relayUrl, profile, testDrag: true });
  try {
    await packs.page.locator('.list .row').first().waitFor();
    await packs.page.locator('#splash').waitFor({ state: 'detached' });
    await packs.page.locator('.nav-i', { hasText: '팩' }).click();
    await packs.page.locator('.pk').first().waitFor();
    await packs.page.locator('.pk[aria-label="twin-two"] .pack', { hasText: '소리 4개' }).waitFor();
    const cards = await packs.page.locator('.pk').evaluateAll((items) => Object.fromEntries(items.map((card) => [card.getAttribute('aria-label'), {
      name: card.querySelector('.fname').textContent, cover: Boolean(card.querySelector('.tile img')), letters: card.querySelector('.tile').textContent,
    }])));
    assert.deepEqual(cards, {
      'impact-sounds-1': { name: 'impact-sounds-1', cover: false, letters: 'IM' },
      'impact-sounds-2': { name: 'impact-sounds-2', cover: false, letters: 'IM' },
      'kenney-alpha-sounds': { name: 'Alpha Deck', cover: true, letters: '' },
      'kenney-beta-sounds': { name: 'kenney-beta', cover: false, letters: 'KE' },
      'kenney-gamma-sounds': { name: 'kenney-gamma', cover: false, letters: 'KE' },
      'twin-one': { name: 'twin-one', cover: false, letters: 'TW' },
      'twin-two': { name: 'twin-two', cover: false, letters: 'TW' },
    });
    await shot(packs.page, 'pack-cards');
    pass('packs: pack.json name and cover read; bad JSON, a linked cover and pack.json from outside the folder, a cover over 5MB, a pack.json over 64KB and a fake image all ignored; short names that collide stay apart, pack.json names too');

    await packs.page.locator('.pk[aria-label="twin-two"]').click();
    await packs.page.locator('.packtop').waitFor();
    const sharedRow = packs.page.locator('.list .row', { hasText: shared });
    assert.equal(await sharedRow.locator('.tile').innerText(), 'TW', 'a sound in two packs shows the pack on screen');
    assert.equal(await sharedRow.locator('button.pack').innerText(), 'twin-two');
    await sharedRow.locator('.tile').click();
    assert.equal(await packs.page.locator('.packtop h1').innerText(), 'twin-two', 'its tile stays in this pack');
    await packs.page.locator('.nav-i', { hasText: '팩' }).click();
    await packs.page.locator('.pk').first().waitFor();

    await packs.page.locator('.pk[aria-label="kenney-alpha-sounds"]').click();
    await packs.page.locator('.packtop').waitFor();
    assert.equal(await packs.page.locator('.packtop .cover img').count(), 1, 'the 120px cover');
    assert.equal(await packs.page.locator('.packtop h1').innerText(), 'Alpha Deck');
    assert.equal(await packs.page.locator('.pfull').innerText(), 'kenney-alpha-sounds');
    const meta = await packs.page.locator('.pmeta').innerText();
    for (const fact of ['QA Studio', 'CC0', 'example.test/alpha']) assert(meta.includes(fact), `pack facts: ${meta}`);
    const revealed = await nextDrag(profile, () => packs.page.getByRole('button', { name: 'Finder에서 보기' }).click());
    assert.equal(path.basename(revealed.reveal), 'LICENSE.txt', 'Finder shows the license file');
    await shot(packs.page, 'pack-head');
    const row = packs.page.locator('.list .row').first();
    assert.equal(await row.locator('.tile img').count(), 1, 'the cover in the row');
    await row.hover();
    await packs.page.waitForFunction(() => !document.querySelector('.list .row').classList.contains('wait'));
    await row.locator('.names').click();
    await packs.page.locator('.player .tile img').waitFor();
    await packs.page.keyboard.press('Escape');
    const covered = await nextDrag(profile, () => row.dispatchEvent('dragstart'));
    assert.deepEqual((await pixels(packs.page, covered.icon.png)).inside, RED, 'the drag picture is the cover');
    await packs.page.locator('[aria-label="뒤로"]').click();
    await packs.page.locator('.pk[aria-label="kenney-beta-sounds"]').click();
    await packs.page.locator('.packtop').waitFor();
    assert.equal(await packs.page.locator('.pmeta').count(), 0, 'no facts, no line');
    assert.equal(await packs.page.locator('.list .row .tile img').count(), 0);
    assert.equal(await packs.page.locator('.list .row .tile').first().innerText(), 'KE', 'the letter tile stands in');
    const lettered = packs.page.locator('.list .row').first();
    await lettered.hover();
    await packs.page.waitForFunction(() => !document.querySelector('.list .row').classList.contains('wait'));
    const plain = await nextDrag(profile, () => lettered.dispatchEvent('dragstart'));
    assert.notDeepEqual((await pixels(packs.page, plain.icon.png)).inside, RED, 'the drag picture is the tile');
    pass('covers: head, row, player and drag picture use the cover; a pack without one uses its letters everywhere, and its drag picture too');
  } finally {
    await packs.close();
  }

  const single = await fs.mkdtemp(path.join(os.tmpdir(), 'proto1-v3-profile-'));
  const [only] = picked.keys();
  const lone = path.join(base, 'One', 'pack', path.basename(only));
  await fs.mkdir(path.dirname(lone), { recursive: true });
  await fs.copyFile(picked.get(only), lone);
  await seedProfile(single, { root: path.join(base, 'One'), place: (file) => (file.path === only ? lone : undefined) });
  const alone = await launchHidden({ relayUrl, profile: single });
  try {
    await alone.page.locator('.list .row').first().waitFor();
    await alone.page.locator('.chatbtn').click();
    const id = await alone.page.locator('.list .row').first().getAttribute('data-id');
    await alone.page.evaluate((sound) => {
      const transfer = new DataTransfer();
      transfer.setData('application/x-proto1-sound', sound);
      document.querySelector('.compose').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, id);
    await alone.page.locator('.attach .fname').waitFor({ timeout: 30_000 });
    await alone.page.locator('.compose-input').press('Enter');
    await alone.page.locator('.ans .say', { hasText: '이 소리와 비슷한 소리가 아직 없어요.' }).waitFor();
    pass('no candidate: a reference alone in its library gets its own sentence');
  } finally {
    await alone.close();
  }
}
