import type { SearchSound } from '../../core/search';

export const fileName = (relativePath: string): string => relativePath.split(/[\\/]/).pop() ?? relativePath;

/** A length in the list and the chat: two decimals, and minutes from 60 seconds on. */
export function seconds(value: number): string {
  if (value < 60) return `${value.toFixed(2)}초`;
  const whole = Math.round(value);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The player's clock: one decimal, and none when it is 0. */
export const tenths = (value: number): string => Number(value.toFixed(1)).toLocaleString('ko-KR');

/** A folder as the screen writes it: the home folder is ~. The space keeps a path inside a sentence in reach. */
export const shortPath = (path: string): string => path.replace(/(^|\s)\/Users\/[^/]+/, '$1~');

export const packNameOf = (sound: SearchSound): string =>
  sound.packName ?? (sound.packId.split(/[\\/]/).filter(Boolean).pop() || sound.packId);

/** The folders between a sound and its pack; empty for a file directly under the pack. */
export function folderInPack({ root = '', packId, relativePath }: SearchSound): string {
  const base = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  const pack = packId.startsWith(base) ? packId.slice(base.length) : '';
  const folders = relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  return pack ? folders.slice(pack.length + 1) : folders;
}

const fillerWord = /^(sounds|audio|sfx|pack|samples)$/i;
const words = (name: string) => [...name.matchAll(/[^-_\s]+/g)];

/**
 * Short pack names (spec 3 and 12): a pack.json name stands; otherwise a first word at least half of the packs share
 * goes, then trailing filler words. Names that would then read the same keep more words until they differ.
 */
export function shortPackNames(packs: readonly { full: string; name?: string }[]): string[] {
  const parts = packs.map(({ full }) => words(full));
  const firsts = new Map<string, number>();
  for (const part of parts) if (part.length > 1) firsts.set(part[0][0].toLowerCase(), (firsts.get(part[0][0].toLowerCase()) ?? 0) + 1);
  const sharers = (part: RegExpExecArray[]) => firsts.get(part[0][0].toLowerCase()) ?? 0;
  const shared = (part: RegExpExecArray[]) => part.length > 1 && sharers(part) > 1 && sharers(part) * 2 >= packs.length
    && !part.slice(1).every(([word]) => fillerWord.test(word));
  const starts = parts.map((part) => (shared(part) ? 1 : 0));
  const ends = parts.map((part, index) => {
    let end = part.length;
    while (end > starts[index] + 1 && fillerWord.test(part[end - 1][0])) end--;
    return end;
  });
  const shown = (index: number) => {
    const part = parts[index];
    if (!part.length) return packs[index].full;
    const last = part[ends[index] - 1];
    return packs[index].full.slice(part[starts[index]].index, last.index + last[0].length);
  };
  const names = packs.map((pack, index) => pack.name ?? shown(index));
  for (let changed = true; changed;) {
    changed = false;
    const repeated = names.filter((name, index) => names.indexOf(name) !== index);
    names.forEach((name, index) => {
      if (packs[index].name || ends[index] >= parts[index].length || !repeated.includes(name)) return;
      ends[index]++;
      names[index] = shown(index);
      changed = true;
    });
  }
  const folded = names.map((name) => name.toLowerCase());
  return names.map((name, index) => (folded.indexOf(folded[index]) !== folded.lastIndexOf(folded[index]) ? packs[index].full : name));
}

export const packCode = (name: string): string =>
  name.replace(/[^A-Za-z0-9가-힣]/g, '').slice(0, 2).toUpperCase() || name.slice(0, 2).toUpperCase();

/** Stretches stored peaks over more bars with straight lines between them, so the wave has no steps. */
export function stretchPeaks(peaks: readonly number[], bars: number): number[] {
  const last = peaks.length - 1;
  return Array.from({ length: bars }, (_, index) => {
    const position = (index * last) / (bars - 1);
    const from = Math.floor(position);
    return peaks[from] + (peaks[Math.min(from + 1, last)] - peaks[from]) * (position - from);
  });
}

export function waveSvg(peaks: readonly number[] | undefined, className: string, bars: number, height: number): SVGSVGElement {
  const width = bars * 3 - 1;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-hidden', 'true');
  const values = peaks?.length ? stretchPeaks(peaks, bars) : [];
  for (let index = 0; index < bars; index++) {
    const barHeight = Math.max(2, Math.round(Math.min(1, values[index] ?? 0) * height));
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(index * 3));
    rect.setAttribute('y', String((height - barHeight) / 2));
    rect.setAttribute('width', '2');
    rect.setAttribute('height', String(barHeight));
    svg.append(rect);
  }
  return svg;
}

export function paintWave(wave: SVGSVGElement, on: number, past: number): void {
  Array.from(wave.children).forEach((bar, index) => {
    const tone = index < on ? 'on' : index < past ? 'past' : '';
    if ((bar.getAttribute('class') ?? '') !== tone) bar.setAttribute('class', tone);
  });
}
