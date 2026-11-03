import type { SearchSound } from '../../core/search';
import { prepareDrag } from './drag';
import { h, iconButton } from './dom';
import { fileName, paintWave, tenths, waveSvg } from './format';
import { icon } from './icons';
import { openPack } from './navigation';
import { app, logSound, platform, soundById, state } from './state';
import { tile } from './tile';

const VOLUME_KEY = 'volume';
const MUTED_KEY = 'muted';

export interface StartOptions {
  origin?: 'list' | 'chat';
  /** The list the sound started from; previous and next follow it. */
  queue?: readonly SearchSound[];
  offset?: number;
  /** Reads a sound from outside the library. */
  bytes?: () => Promise<ArrayBuffer>;
}

export const player = {
  sound: undefined as SearchSound | undefined,
  playing: false,
  position: 0,
  length: 0,
  origin: 'list' as NonNullable<StartOptions['origin']>,
  queue: [] as readonly SearchSound[],
  abort: undefined as AbortController | undefined,
};

/** The farthest share of each sound reached since the app opened. */
const heard = new Map<string, number>();
const keyOf = (sound: SearchSound) => sound.fullHash ?? sound.id;
const isCurrent = (sound: SearchSound) => player.sound?.id === sound.id;

export const isPlaying = (sound: SearchSound) => player.playing && isCurrent(sound);

function notePosition(): void {
  const position = platform.search?.position();
  if (position !== undefined) player.position = player.length ? Math.min(position, player.length) : position;
  if (!player.sound || !player.length) return;
  const key = keyOf(player.sound);
  heard.set(key, Math.max(heard.get(key) ?? 0, player.position / player.length));
}

export function waveShares(sound: SearchSound, bars: number): { on: number; past: number } {
  const now = isCurrent(sound) && player.length ? player.position / player.length : 0;
  return { on: Math.round(bars * now), past: Math.round(bars * Math.max(now, heard.get(keyOf(sound)) ?? 0)) };
}

export function stop(): void {
  notePosition();
  player.abort?.abort();
  platform.search?.stop();
  player.playing = false;
  syncPlayer();
  app.refreshList();
  app.chat?.refresh();
}

export async function play(sound: SearchSound, options: StartOptions = {}): Promise<void> {
  if (sound.blockedReason) { app.showError(sound.blockedReason); return; }
  const inLibrary = Boolean(soundById(sound.id));
  if (inLibrary && !isCurrent(sound)) logSound('play', sound);
  notePosition();
  player.abort?.abort();
  const abort = new AbortController();
  player.abort = abort;
  player.sound = sound;
  player.origin = options.origin ?? player.origin;
  player.queue = options.queue ?? player.queue;
  player.playing = true;
  player.position = options.offset ?? 0;
  player.length = sound.duration;
  syncPlayer();
  app.refreshList();
  app.chat?.refresh();
  if (inLibrary) prepareDrag(sound);
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(tick);
  try {
    await platform.search!.play(sound, abort.signal, {
      offset: options.offset,
      bytes: options.bytes,
      ended: () => {
        if (player.abort !== abort) return;
        player.position = player.length;
        notePosition();
        player.playing = false;
        syncPlayer();
        app.refreshList();
        app.chat?.refresh();
      },
    });
    if (player.abort === abort) player.length = platform.search!.duration() ?? player.length;
  } catch (error) {
    if (abort.signal.aborted) return;
    player.playing = false;
    syncPlayer();
    app.refreshList();
    // Only our own sentences are in Korean; the decoder's English says nothing to the person.
    app.showError(error instanceof Error && /\p{Script=Hangul}/u.test(error.message) ? error.message : '소리를 재생하지 못했습니다.');
  }
}

export function toggle(sound: SearchSound, options: StartOptions = {}): void {
  if (isPlaying(sound)) { stop(); return; }
  if (isCurrent(sound)) void play(sound, { offset: player.position < player.length ? player.position : 0 });
  else void play(sound, options);
}

export function seek(sound: SearchSound, share: number, options: StartOptions = {}): void {
  void play(sound, { ...options, offset: share * (isCurrent(sound) ? player.length : sound.duration) });
}

export function skip(): void {
  if (player.sound && player.length) seek(player.sound, Math.min(1, player.position / player.length + 0.2));
}

const order = (): readonly SearchSound[] => {
  const live = player.origin === 'chat' ? app.chat?.results() ?? [] : [];
  return live.some(isCurrent) ? live : player.queue;
};

function step(offset: number): void {
  const list = order();
  const target = list[list.findIndex(isCurrent) + offset];
  if (!target) return;
  const next = soundById(target.id) ?? target;
  if (player.origin === 'list') {
    state.selectedId = next.id;
    app.reveal(next);
  }
  void play(next);
}

const previous = iconButton(icon('prev', 18), '이전', () => step(-1));
const toggleButton = iconButton(icon('play', 20), '재생', () => { if (player.sound) toggle(player.sound); }, 'ib pp');
const next = iconButton(icon('next', 18), '다음', () => step(1));
const tileSlot = h('span', { class: 'tile-slot' });
const nameLabel = h('span', { class: 'fname' });
const packLabel = h('button', { class: 'pack', type: 'button', on: { click: () => { if (player.sound) openPack(player.sound.packId); } } });
const waveCell = h('div', {
  class: 'bigwave-cell',
  on: {
    click: (event) => {
      const box = waveCell.getBoundingClientRect();
      if (player.sound && box.width) seek(player.sound, (event.clientX - box.left) / box.width);
    },
  },
});
const clock = h('b');
const total = h('span');
const speaker = iconButton(icon('vol', 18), '음소거', toggleMute);
const slider = h('input', { class: 'slider', attrs: { type: 'range', min: '0', max: '100', step: '1', 'aria-label': '음량' } });

export const playerBar = h('footer', { class: 'player', attrs: { 'aria-label': '재생', hidden: true } },
  h('div', { class: 'transport' }, previous, toggleButton, next), tileSlot,
  h('span', { class: 'names' }, nameLabel, packLabel), waveCell,
  h('span', { class: 'num time' }, clock, total),
  h('div', { class: 'volume' }, speaker, slider));

const savedVolume = () => {
  const value = Number(localStorage.getItem(VOLUME_KEY) ?? 100);
  return value >= 0 && value <= 100 ? value : 100;
};
let volume = savedVolume();
let muted = localStorage.getItem(MUTED_KEY) === '1';

function applyVolume(): void {
  platform.search?.setGain(muted ? 0 : volume / 100);
  const shown = muted ? 0 : volume;
  slider.value = String(shown);
  slider.style.setProperty('--v', `${shown}%`);
  speaker.replaceChildren(icon(muted ? 'mute' : 'vol', 18));
  speaker.setAttribute('aria-label', muted ? '음소거 해제' : '음소거');
}

function toggleMute(): void {
  muted = !muted;
  localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  applyVolume();
}

slider.addEventListener('pointerup', () => { slider.blur(); app.focusList(); });
slider.addEventListener('input', () => {
  volume = Number(slider.value);
  muted = false;
  localStorage.setItem(VOLUME_KEY, slider.value);
  localStorage.setItem(MUTED_KEY, '0');
  applyVolume();
});

let drawnWave = '';
function drawWave(): void {
  const sound = player.sound;
  const bars = Math.floor(waveCell.clientWidth / 3);
  const key = sound && bars > 1 ? `${sound.id}\0${bars}` : '';
  if (key === drawnWave) return;
  drawnWave = key;
  waveCell.replaceChildren(...(sound && key ? [waveSvg(sound.peaks, 'bigwave', bars, 30)] : []));
}

function paint(): void {
  const sound = player.sound;
  if (!sound) return;
  clock.textContent = tenths(player.position);
  // A click shorter than 0.05 seconds is still a sound, so it never reads as 0.
  total.textContent = ` / ${tenths(player.length && Math.max(player.length, 0.1))}초`;
  const row = document.querySelector<SVGSVGElement>(`.list .row[data-id="${CSS.escape(sound.id)}"] .wave`);
  for (const wave of [waveCell.firstElementChild as SVGSVGElement | null, row]) {
    if (wave) { const { on, past } = waveShares(sound, wave.childElementCount); paintWave(wave, on, past); }
  }
}

let frame = 0;
function tick(): void {
  notePosition();
  paint();
  if (player.playing) frame = requestAnimationFrame(tick);
}

let drawnSound = '';
/** Updates the bar in place: the volume slider and the wave must survive every sound and every frame. */
export function syncPlayer(): void {
  const sound = player.sound;
  const appearing = playerBar.hidden && sound;
  playerBar.hidden = !sound;
  if (!sound) return;
  // The bar takes its height from the list, and the row just clicked may be the one it covers.
  const selected = appearing && state.selectedId ? soundById(state.selectedId) : undefined;
  if (selected) app.reveal(selected);
  const pack = state.packs.get(sound.packId);
  const identity = `${sound.id}\0${pack?.code}\0${pack?.name}\0${pack?.cover}`;
  if (identity !== drawnSound) {
    drawnSound = identity;
    tileSlot.replaceChildren(tile(pack, ({ id }) => openPack(id)));
    nameLabel.textContent = fileName(sound.relativePath);
    packLabel.textContent = pack?.name ?? '';
    packLabel.setAttribute('aria-label', pack?.full ?? '');
  }
  const label = player.playing ? '일시 정지' : '재생';
  if (toggleButton.getAttribute('aria-label') !== label) {
    toggleButton.setAttribute('aria-label', label);
    toggleButton.replaceChildren(icon(player.playing ? 'pause' : 'play', 20));
  }
  const list = order();
  const index = list.findIndex(isCurrent);
  previous.disabled = index <= 0;
  next.disabled = index < 0 || index >= list.length - 1;
  drawWave();
  paint();
}

export function mountPlayer(): void {
  applyVolume();
  new ResizeObserver(drawWave).observe(waveCell);
}
