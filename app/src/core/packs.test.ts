import { describe, expect, it } from 'vitest';
import { coverNames, coverType, licenseName, packJsonName, parsePackJson } from './packs';

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};
const webp = (kind: string, write: (view: DataView) => void) => {
  const bytes = new Uint8Array(40);
  bytes.set(new TextEncoder().encode(`RIFF0000WEBP${kind}`));
  write(new DataView(bytes.buffer));
  return bytes;
};

describe('coverNames', () => {
  it('takes the four names in the four formats, in any case, best first', () => {
    expect(coverNames(['album.webp', 'x.png', 'Folder.JPG', 'cover.jpeg', 'COVER.PNG', 'cover.gif', 'cover.png.txt', 'cover']))
      .toEqual(['COVER.PNG', 'cover.jpeg', 'Folder.JPG', 'album.webp']);
  });
});

describe('side files', () => {
  it('finds pack.json and a license file by name alone', () => {
    expect(packJsonName(['a.wav', 'Pack.JSON'])).toBe('Pack.JSON');
    expect(licenseName(['a.wav', 'License.txt'])).toBe('License.txt');
    expect(licenseName(['LICENCE'])).toBe('LICENCE');
    expect(licenseName(['licensed-sounds.txt'])).toBeUndefined();
  });
});

describe('coverType', () => {
  it('reads the real format from the header, whatever the file is called', () => {
    expect(coverType(png(1024, 1024))).toBe('image/png');
    expect(coverType(webp('VP8X', (view) => { view.setUint32(24, 511, true); view.setUint32(27, 511, true); }))).toBe('image/webp');
    expect(coverType(webp('VP8L', (view) => view.setUint32(21, 511 | (511 << 14), true)))).toBe('image/webp');
    const jpeg = new Uint8Array(40);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 2, 0, 2, 0]);
    expect(coverType(jpeg)).toBe('image/jpeg');
  });

  it('refuses text, a file too short for a header, and an image too large to decode', () => {
    expect(coverType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeUndefined();
    expect(coverType(new Uint8Array(4))).toBeUndefined();
    expect(coverType(png(5000, 10))).toBeUndefined();
    expect(coverType(png(4096, 4096))).toBeUndefined();
  });
});

describe('parsePackJson', () => {
  it('reads the five fields and caps what it keeps', () => {
    const tags = Array.from({ length: 12 }, (_, index) => `tag${index}`);
    expect(parsePackJson(JSON.stringify({ name: ' RPG ', creator: 'Kenney', source: 'https://kenney.nl', license: 'CC0-1.0', tags, extra: 1 })))
      .toEqual({ name: 'RPG', creator: 'Kenney', source: 'https://kenney.nl', license: 'CC0-1.0', tags: tags.slice(0, 8) });
    expect(parsePackJson(JSON.stringify({ name: 'x'.repeat(500) })).name).toHaveLength(80);
  });

  it('leaves out a field in the wrong shape and keeps the rest', () => {
    expect(parsePackJson(JSON.stringify({ name: 7, creator: 'Kenney', tags: 'rpg' }))).toEqual({ creator: 'Kenney' });
    expect(parsePackJson(JSON.stringify({ tags: ['ok', 3, ''] }))).toEqual({ tags: ['ok'] });
  });

  it.each(['not json', '[]', 'null', '"text"', ''])('says nothing for %j', (source) => {
    expect(parsePackJson(source)).toEqual({});
  });

  it('reads a file that starts with a byte order mark', () => {
    expect(parsePackJson('\uFEFF{"name":"RPG"}')).toEqual({ name: 'RPG' });
  });
});
