import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COVER_LIMIT, PACK_JSON_LIMIT } from '../core/packs';
import { findLicense, readPackDetails } from './packs';

const png = () => {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(16, 16);
  bytes.writeUInt32BE(16, 20);
  return bytes;
};

let temporary: string;
let root: string;
let pack: string;
beforeEach(() => {
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proto1-packs-test-')));
  root = path.join(temporary, 'Library');
  pack = path.join(root, 'Pack');
  fs.mkdirSync(pack, { recursive: true });
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

describe('readPackDetails', () => {
  it('reads the cover as a data URL and the facts of pack.json', async () => {
    fs.writeFileSync(path.join(pack, 'cover.png'), png());
    fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ name: 'RPG', license: 'CC0-1.0' }));
    fs.writeFileSync(path.join(pack, 'License.txt'), 'CC0');
    const details = await readPackDetails(root, pack);
    expect(details).toMatchObject({ id: pack, name: 'RPG', license: 'CC0-1.0', licenseFile: true });
    expect(details.cover).toBe(`data:image/png;base64,${png().toString('base64')}`);
  });

  it('gives only the id for a folder with none of it', async () => {
    expect(await readPackDetails(root, pack)).toEqual({ id: pack });
  });

  it('ignores a bad pack.json and a cover that is no image', async () => {
    fs.writeFileSync(path.join(pack, 'cover.png'), 'not an image at all, only text that is long enough to have a header');
    fs.writeFileSync(path.join(pack, 'pack.json'), '{ nope');
    expect(await readPackDetails(root, pack)).toEqual({ id: pack });
  });

  it('goes on to the next cover when the first one is bad', async () => {
    fs.writeFileSync(path.join(pack, 'cover.png'), 'bad');
    fs.writeFileSync(path.join(pack, 'folder.png'), png());
    expect((await readPackDetails(root, pack)).cover).toContain('data:image/png');
  });

  it('refuses files over the limits without reading them', async () => {
    fs.writeFileSync(path.join(pack, 'cover.png'), Buffer.concat([png(), Buffer.alloc(COVER_LIMIT)]));
    fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ name: 'x'.repeat(PACK_JSON_LIMIT) }));
    expect(await readPackDetails(root, pack)).toEqual({ id: pack });
  });

  it('refuses links that lead out of the connected folder, and takes links that stay inside', async () => {
    fs.writeFileSync(path.join(temporary, 'outside.png'), png());
    fs.writeFileSync(path.join(temporary, 'outside.json'), '{"name":"outside"}');
    fs.symlinkSync(path.join(temporary, 'outside.png'), path.join(pack, 'cover.png'));
    fs.symlinkSync(path.join(temporary, 'outside.json'), path.join(pack, 'pack.json'));
    expect(await readPackDetails(root, pack)).toEqual({ id: pack });
    fs.writeFileSync(path.join(root, 'shared.png'), png());
    fs.symlinkSync(path.join(root, 'shared.png'), path.join(pack, 'folder.png'));
    expect((await readPackDetails(root, pack)).cover).toContain('data:image/png');
  });

  it('refuses a pack id outside the connected folder, a sibling with the same prefix too', async () => {
    const sibling = `${root}-other`;
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'cover.png'), png());
    expect(await readPackDetails(root, sibling)).toEqual({ id: sibling });
    expect(await readPackDetails(root, path.join(root, '..'))).toEqual({ id: path.join(root, '..') });
  });

  it('takes a directory named like a cover for nothing', async () => {
    fs.mkdirSync(path.join(pack, 'cover.png'));
    expect(await readPackDetails(root, pack)).toEqual({ id: pack });
  });
});

describe('findLicense', () => {
  it('finds the file only inside the connected folder', async () => {
    fs.writeFileSync(path.join(temporary, 'LICENSE'), 'x');
    fs.symlinkSync(path.join(temporary, 'LICENSE'), path.join(pack, 'LICENSE'));
    expect(await findLicense(root, pack)).toBeUndefined();
    fs.rmSync(path.join(pack, 'LICENSE'));
    fs.writeFileSync(path.join(pack, 'License.txt'), 'x');
    expect(await findLicense(root, pack)).toBe(path.join(pack, 'License.txt'));
  });
});
