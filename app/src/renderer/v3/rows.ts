import type { SearchSound } from '../../core/search';
import { openRowMenu, toggleFavorite } from './collections';
import { h, iconButton } from './dom';
import { dragStatus, prepareDrag, startDrag } from './drag';
import { fileName, folderInPack, paintWave, waveSvg } from './format';
import { icon } from './icons';
import { openPack } from './navigation';
import { isPlaying, play, seek, toggle, waveShares } from './player';
import { app, favorites, lengthText, platform, state, web } from './state';
import { tile } from './tile';

const ROW = 52;
const WAVE_HEIGHT = 26;
const AHEAD = 8;

/** The wave column follows the width of the list, not the window: both panes can squeeze it. */
const waveSteps = [{ from: 860, bars: 80 }, { from: 720, bars: 64 }, { from: 572, bars: 40 }];
export const shape = { bars: 80, compact: false };

const listStart = () => ({ origin: 'list' as const, queue: state.visible });

export function select(sound: SearchSound, toggling = false): void {
  state.selectedId = sound.id;
  if (toggling) toggle(sound, listStart());
  else if (state.autoplay) void play(sound, listStart());
  prepareDrag(sound);
  list.refresh();
}

function rowWave(sound: SearchSound): SVGSVGElement {
  const wave = waveSvg(sound.peaks, 'wave', shape.bars, WAVE_HEIGHT);
  wave.addEventListener('click', (event) => {
    event.stopPropagation();
    const box = wave.getBoundingClientRect();
    state.selectedId = sound.id;
    seek(sound, (event.clientX - box.left) / box.width, listStart());
    prepareDrag(sound);
    list.refresh();
  });
  return wave;
}

function syncRow(row: HTMLLIElement, sound: SearchSound): void {
  const selected = state.selectedId === sound.id;
  const playing = isPlaying(sound);
  row.classList.toggle('sel', selected);
  row.setAttribute('aria-selected', String(selected));
  row.classList.toggle('now', playing);
  const button = row.querySelector<HTMLElement>('.play')!;
  const label = `${fileName(sound.relativePath)} ${playing ? '일시 정지' : '재생'}`;
  if (button.getAttribute('aria-label') !== label) {
    button.setAttribute('aria-label', label);
    button.replaceChildren(icon(playing ? 'pause' : 'play', 16));
  }
  const waiting = dragStatus(sound) === 'preparing';
  if (row.classList.contains('wait') !== waiting) {
    row.classList.toggle('wait', waiting);
    row.setAttribute('aria-busy', String(waiting));
    if (waiting) row.querySelectorAll('.play, .tile').forEach((place) => place.append(icon('ring', 16, 'i ring')));
    else row.querySelectorAll('.ring').forEach((ring) => ring.remove());
  }
  const wave = row.querySelector<SVGSVGElement>('.wave');
  if (wave) { const { on, past } = waveShares(sound, shape.bars); paintWave(wave, on, past); }
}

function rowFor(sound: SearchSound, index: number): HTMLLIElement {
  // The same file in two packs is one sound; on a pack's screen it belongs to that pack.
  const pack = state.packs.get(state.route.view === 'pack' ? state.route.id : sound.packId);
  const name = fileName(sound.relativePath);
  const blocked = Boolean(sound.blockedReason);
  const liked = Boolean(sound.fullHash && favorites().has(sound.fullHash));
  // Every row of a pack's screen would repeat its name, so the folder inside the pack says more.
  const folder = state.route.view === 'pack' && state.route.id === sound.packId ? folderInPack(sound) : '';
  const row = h('li', {
    class: `row${blocked ? ' off' : ''}`,
    style: `top:${index * ROW}px`,
    dataset: { id: sound.id },
    attrs: { draggable: blocked ? undefined : 'true', 'aria-selected': 'false' },
  },
  iconButton(icon('play', 16), `${name} 재생`, (event) => { event.stopPropagation(); select(sound, true); list.holdKeys(); }, 'ib play'),
  shape.compact ? null : tile(pack, ({ id }) => openPack(id)),
  h('span', { class: 'names' }, h('span', { class: 'fname', text: name }),
    folder ? h('span', { class: 'pack', text: folder, attrs: { 'aria-label': folder } })
      : h('button', { class: 'pack', type: 'button', text: pack?.name ?? '', attrs: { 'aria-label': pack?.full }, on: { click: (event) => { event.stopPropagation(); openPack(sound.packId); } } })),
  !shape.bars ? null : blocked ? h('span', { class: 'gone', text: web ? '폴더 권한 필요' : '드라이브 없음' }) : rowWave(sound),
  h('span', { class: 'num dur', text: lengthText(sound) }),
  shape.compact ? null : iconButton(icon(liked ? 'heartOn' : 'heart', 16), liked ? '즐겨찾기 해제' : '즐겨찾기', (event) => { event.stopPropagation(); toggleFavorite(sound); }, `ib heart${liked ? ' on' : ''}`),
  web && platform.search?.download ? iconButton(icon('dl', 16), '다운로드', (event) => {
    event.stopPropagation();
    void platform.search!.download!(sound).catch(() => app.showError('소리를 다운로드하지 못했습니다.'));
  }, 'ib dl') : null,
  iconButton(icon('more', 16), '메뉴', (event) => { event.stopPropagation(); openRowMenu(event.currentTarget as HTMLElement, sound); }, 'ib mb'));
  // A double click is one wish to hear the sound, not a start and a stop.
  row.addEventListener('click', (event) => { if (event.detail < 2) select(sound, true); });
  if (!blocked) {
    row.addEventListener('pointerenter', () => prepareDrag(sound));
    row.addEventListener('dragstart', (event) => { row.classList.add('dragging'); startDrag(event, sound); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  }
  syncRow(row, sound);
  return row;
}

export const list = (() => {
  const scroller = h('ul', { class: 'list vlist', attrs: { role: 'listbox', tabindex: '0', 'aria-label': '소리' } });
  const spacer = h('li', { class: 'vspace', attrs: { 'aria-hidden': 'true' } });
  let shown = new Map<number, HTMLLIElement>();
  let frame = 0;

  /** Rows that stay on screen are kept, so a row under the pointer survives scrolling and playback. */
  const draw = (rebuild: boolean) => {
    frame = 0;
    const items = state.visible;
    spacer.style.height = `${items.length * ROW}px`;
    const focused = scroller.contains(document.activeElement);
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW) - AHEAD);
    const last = Math.min(items.length, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW) + AHEAD);
    const kept = new Map<number, HTMLLIElement>();
    for (const [index, row] of shown) {
      if (!rebuild && index >= first && index < last && row.dataset.id === items[index]?.id) kept.set(index, row);
      else row.remove();
    }
    for (let index = first; index < last; index++) {
      if (kept.has(index)) continue;
      const row = rowFor(items[index], index);
      kept.set(index, row);
      scroller.append(row);
    }
    shown = kept;
    // A row button that had focus can be gone now; the list keeps it so the arrow keys go on working.
    if (focused && !scroller.contains(document.activeElement)) scroller.focus({ preventScroll: true });
  };

  scroller.append(spacer);
  scroller.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(() => draw(false)); });
  const moveWith = (event: KeyboardEvent) => {
    const items = state.visible;
    if (!items.length) return;
    const index = items.findIndex((sound) => sound.id === state.selectedId);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      reveal(items.indexOf(next));
      select(next);
    } else if (event.key === 'Enter' && index >= 0) { event.preventDefault(); select(items[index], true); }
  };
  scroller.addEventListener('keydown', moveWith);
  const reveal = (index: number) => {
    if (index < 0) return;
    if (index * ROW < scroller.scrollTop) scroller.scrollTop = index * ROW;
    else if ((index + 1) * ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = (index + 1) * ROW - scroller.clientHeight;
  };
  return {
    element: scroller,
    /** After the list itself changed. */
    rebuild: () => { if (scroller.isConnected) draw(true); },
    /** After a state of its rows changed: selection, playback, drag copies. */
    refresh: () => { for (const [index, row] of shown) if (row.dataset.id === state.visible[index]?.id) syncRow(row, state.visible[index]); },
    focus: () => scroller.focus({ preventScroll: true }),
    /** The row at the top edge, and how far into it the list stands. */
    topRow: () => {
      const index = Math.floor(scroller.scrollTop / ROW);
      const sound = state.visible[index];
      return sound && { id: sound.id, into: scroller.scrollTop - index * ROW };
    },
    /** Rows that arrive above the view leave what is on screen where it was. */
    holdRow: (top?: { id: string; into: number }) => {
      const index = top && scroller.isConnected ? state.visible.findIndex((sound) => sound.id === top.id || sound.mergedIds?.includes(top.id)) : -1;
      if (index < 0) return;
      scroller.scrollTop = index * ROW + top!.into;
      draw(true);
    },
    /** A key that went nowhere because nothing holds the focus. */
    takeKey: (event: KeyboardEvent) => { scroller.focus({ preventScroll: true }); moveWith(event); },
    /** A click inside the list leaves the keys with the list, never on the row's button. */
    holdKeys: () => { if (scroller.contains(document.activeElement)) scroller.focus({ preventScroll: true }); },
    reveal,
  };
})();

export function fitList(library: HTMLElement): void {
  const width = library.getBoundingClientRect().width;
  const extra = web ? 40 : 0;
  const bars = state.narrow ? 0 : waveSteps.find(({ from }) => width >= from + extra)?.bars ?? 0;
  const compact = state.narrow || width < 480;
  if (bars === shape.bars && compact === shape.compact) return;
  shape.bars = bars;
  shape.compact = compact;
  library.classList.toggle('nowave', !bars);
  library.classList.toggle('compact', compact);
  library.style.setProperty('--wave-w', `${bars * 3 - 1}px`);
  list.rebuild();
}
