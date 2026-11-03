import { supportedWebEnvironment } from '../../platform/web/support';
import type { PackDetails } from '../../core/packs';
import { loadModel } from '../../model';
import { mountChat } from './chat';
import { openRowMenu } from './collections';
import { h, iconButton, imeKey } from './dom';
import { droppedSound, prepareDrag, startDrag } from './drag';
import { coverDecodes } from './drag-image';
import { icon, mark } from './icons';
import { describePacks, uniqueSounds } from './library';
import { go, nameCollection, nav, renderNav } from './nav';
import { backButton, forwardButton, navigate, openPack, releaseFilters, searchBox, searchInput, syncHistory } from './navigation';
import { createPanes } from './panes';
import { isPlaying, mountPlayer, play, player, playerBar, seek, skip, stop, syncPlayer, toggle } from './player';
import { fitList, list, select } from './rows';
import { loadTracking, settingsView } from './settings';
import { analysing, app, lengthText, platform, soundById, state, web } from './state';
import { renderStrip as drawStrip, strip } from './strip';
import { dropOrphanTooltip, mountTooltips } from './tooltip';
import { listView, packsView } from './views';
import './style.css';

const MODELS_KEY = 'modelsReady';
const SPLASH_MIN_MS = 300;
/** Screens that are gone (PRD V40): a route that still names one opens all sounds. */
const REMOVED_VIEWS: ReadonlySet<string> = new Set(['classify']);

let errorTimer: ReturnType<typeof setTimeout> | undefined;
function showError(message: string): void {
  state.error = message;
  renderStrip();
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { state.error = ''; renderStrip(); }, 8000);
}

const root = document.querySelector<HTMLDivElement>('#app')!;
root.className = `app${web ? ' web' : /Mac/.test(navigator.platform) ? ' mac' : ''}`;
const menuButton = iconButton(icon('menu', 18), '메뉴', () => { state.navOpen = !state.navOpen; render(); });
function openChat(open: boolean): void {
  state.chatOpen = open;
  // Without room for the list's length column, the menu gives way first.
  if (open && !panes.fit()) state.navOpen = false;
  render();
  if (open) app.chat?.focus();
}
const chatMark = mark(16);
const chatButton = h('button', { class: 'chatbtn', type: 'button', attrs: { 'aria-pressed': 'false' }, on: { click: () => openChat(!state.chatOpen) } }, chatMark, h('span', { text: 'fetch ai' }));
const logo = h('button', { class: 'brand', type: 'button', attrs: { 'aria-label': 'fetch 홈' }, on: { click: goHome } },
  h('img', { attrs: { src: new URL('./fetch-wordmark.svg', import.meta.url).href, alt: '', height: '15' } }));
const top = h('header', { class: 'top', dataset: { odId: 'top-bar' } }, menuButton, backButton, forwardButton, logo, searchBox, h('div', { class: 'spacer' }), chatButton);
const content = h('section', { class: 'library', attrs: { 'aria-label': '소리 목록' } });
const chatPane = h('div', { class: 'chat-in' });
const chatSlot = h('aside', { class: 'chat', attrs: { 'aria-label': 'fetch ai' } }, chatPane);
const panes = createPanes(() => ({ menu: state.navOpen, panel: state.chatOpen }), () => !state.cover, { menu: nav, panel: chatSlot });
const body = h('div', { class: 'body' }, nav, panes.menuEdge, content, panes.panelEdge, chatSlot);
root.append(top, body, playerBar, strip);

/** A mouse click on a button leaves the keys with the list; Tab still reaches every button. */
function keepKeys(event: MouseEvent): void {
  if (!(event.target as Element).closest('button')) return;
  event.preventDefault();
  const held = document.activeElement as HTMLElement;
  if (held.matches('input')) {
    held.blur();
    list.focus();
  }
}
for (const bar of [top, nav, playerBar]) bar.addEventListener('mousedown', keepKeys);

let dragTimer: ReturnType<typeof setTimeout> | undefined;
menuButton.addEventListener('dragenter', () => {
  clearTimeout(dragTimer);
  dragTimer = setTimeout(() => { if (!state.navOpen) { state.navOpen = true; render(); } }, 500);
});
menuButton.addEventListener('dragleave', () => clearTimeout(dragTimer));
chatButton.addEventListener('dragenter', () => {
  clearTimeout(dragTimer);
  chatButton.classList.add('over');
  dragTimer = setTimeout(() => {
    chatButton.classList.remove('over');
    if (!state.chatOpen && !chatButton.disabled) openChat(true);
  }, 500);
});
chatButton.addEventListener('dragleave', () => { clearTimeout(dragTimer); chatButton.classList.remove('over'); });

/** The logo: the whole library from the top. Playback, sort, the open panes and the chat tabs stay. */
function goHome(): void {
  navigate(() => {
    // In a narrow window the panel covers the list.
    if (state.cover) state.chatOpen = false;
    releaseFilters();
    state.route = { view: 'all' };
  });
  searchInput.focus();
}

function render(place?: { scrollTop: number }): void {
  if (REMOVED_VIEWS.has(state.route.view)) state.route = { view: 'all' };
  // What held the focus is rebuilt below, so the list takes it over and the arrow keys go on working.
  const contentFocused = content.contains(document.activeElement);
  const listTop = list.element.isConnected ? list.element.scrollTop : 0;
  renderNav();
  const view = state.route.view;
  content.replaceChildren(...(view === 'packs' ? packsView() : view === 'settings' ? settingsView() : listView()));
  // The rows set the height first, so a saved position is not cut off by a list that was shorter.
  list.rebuild();
  const owner = content.querySelector<HTMLElement>('.list, .packs, .set');
  // Attaching the list again resets both.
  if (owner) owner.scrollTop = place?.scrollTop ?? (owner === list.element ? listTop : owner.scrollTop);
  if (contentFocused && list.element.isConnected) list.focus();
  list.rebuild();
  syncHistory();
  const hasSounds = state.sounds.length > 0;
  chatButton.disabled = !hasSounds;
  if (!hasSounds) state.chatOpen = false;
  chatButton.setAttribute('aria-pressed', String(state.chatOpen));
  chatMark.classList.toggle('hot', !state.chatOpen);
  root.classList.toggle('nav-open', state.navOpen);
  root.classList.toggle('chat-open', state.chatOpen);
  panes.layout();
  renderStrip();
  syncPlayer();
  dropOrphanTooltip();
}

const renderStrip = () => drawStrip(() => void preloadModels());

searchInput.addEventListener('keydown', (event) => {
  if (imeKey(event)) return;
  if (event.key === 'ArrowDown' && state.visible.length) { event.preventDefault(); list.focus(); select(state.visible[0]); }
});

const listStart = () => ({ origin: 'list' as const, queue: state.visible });
const chatStart = () => ({ origin: 'chat' as const, queue: app.chat?.results() ?? [] });

/** Space, left and right play from wherever the keyboard is, unless a box or the resize edge owns them. */
function playbackKey(event: KeyboardEvent): void {
  const moves = event.code === 'Space' || event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  if (!moves || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || imeKey(event)) return;
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea, select, [contenteditable], [role=separator]')) return;
  if (event.code === 'Space' && target.closest('button, a, summary') && target.matches(':focus-visible')) return;
  const inChat = chatSlot.contains(target);
  const selected = (inChat ? app.chat?.selected() : undefined) ?? (state.selectedId ? soundById(state.selectedId) : undefined);
  const start = inChat ? chatStart() : listStart();
  event.preventDefault();
  if (event.code === 'Space') {
    const sound = selected ?? player.sound;
    if (sound) toggle(sound, start);
  } else if (player.sound) {
    if (event.key === 'ArrowLeft') void play(player.sound, { offset: 0 });
    else skip();
  } else if (selected) {
    if (event.key === 'ArrowLeft') void play(selected, start);
    else seek(selected, 0.2, start);
  }
}

document.addEventListener('keydown', (event) => {
  if (event.target === document.body && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && list.element.isConnected) { list.takeKey(event); return; }
  if (event.key !== 'Escape') { playbackKey(event); return; }
  // Where the menu bar covers the list, Escape closes it like a menu and the sound plays on.
  if (state.cover && state.navOpen) { state.navOpen = false; render(); return; }
  if (player.playing) stop();
});

window.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  const connected = platform.connections?.connectDrop?.(event.dataTransfer);
  void connected?.catch((error) => showError(error instanceof Error ? error.message : '폴더를 연결하지 못했습니다.'));
});

const narrowQuery = matchMedia('(max-width: 719px)');
const coverQuery = matchMedia('(max-width: 779px)');
const applyNarrow = () => {
  state.narrow = narrowQuery.matches;
  state.cover = coverQuery.matches;
  // Where the menu covers the list, it opens only when asked for.
  if (state.cover) state.navOpen = false;
  root.classList.toggle('nar', state.narrow);
  root.classList.toggle('covering', state.cover);
  fitList(content);
  render();
};
narrowQuery.addEventListener('change', applyNarrow);
coverQuery.addEventListener('change', applyNarrow);
window.addEventListener('resize', () => {
  if (state.navOpen && state.chatOpen && !panes.fit()) { state.navOpen = false; render(); }
  else panes.layout();
});

let soundTimer: ReturnType<typeof setTimeout> | undefined;
let lastLoad = 0;
let packDetails = new Map<string, PackDetails>();

async function loadPackDetails(): Promise<void> {
  // A pack without its details is still a pack: the tile and the folder name stand in.
  const details = await platform.packs?.load().catch(() => []) ?? [];
  const checked = await Promise.all(details.map(async (pack) => (pack.cover && !await coverDecodes(pack.cover) ? { ...pack, cover: undefined } : pack)));
  packDetails = new Map(checked.map((pack) => [pack.id, pack]));
}

async function loadSounds(rereadPacks = false): Promise<void> {
  if (!platform.search) return;
  lastLoad = Date.now();
  try {
    const rows = await platform.search.loadSounds();
    if (rereadPacks || rows.some((row) => !packDetails.has(row.packId))) await loadPackDetails();
    const top = list.topRow();
    state.sounds = uniqueSounds(rows);
    state.packs = describePacks(rows, packDetails);
    state.loaded = true;
    app.chat?.refresh();
    render();
    list.holdRow(top);
  } catch (error) {
    showError(error instanceof Error ? error.message : '소리 목록을 불러오지 못했습니다.');
  }
}

function scheduleSounds(): void {
  clearTimeout(soundTimer);
  soundTimer = setTimeout(() => void loadSounds(), Math.max(0, 2500 - (Date.now() - lastLoad)));
}

async function loadCategories(): Promise<void> {
  if (!platform.classify) return;
  try {
    const overview = await platform.classify.overview();
    state.categories = new Map(overview.sounds.filter((sound) => sound.category).map((sound) => [sound.fullHash, sound.category!]));
    render();
  } catch { /* The kind filter falls back to UCS names in file names. */ }
}

/** Both models start arriving at once, so neither a folder nor a first request waits for them (PRD 7.6). */
async function preloadModels(): Promise<void> {
  if (localStorage.getItem(MODELS_KEY)) return;
  state.models = 'loading';
  renderStrip();
  try {
    await loadModel('audio');
    await loadModel('text');
    localStorage.setItem(MODELS_KEY, '1');
    state.models = 'idle';
  } catch {
    state.models = 'failed';
  }
  renderStrip();
}

/** The start screen comes from index.html, so it is there on the first frame; it never waits for analysis or models. */
function hideSplash(): void {
  setTimeout(() => document.querySelector('#splash')?.remove(), Math.max(0, Math.ceil(SPLASH_MIN_MS - performance.now())));
}

async function start(): Promise<void> {
  if (web && !supportedWebEnvironment(navigator.userAgent, innerWidth)) {
    root.replaceChildren(h('div', { class: 'none' }, h('p', { text: '이 체험판은 데스크톱 Chrome과 Edge에서만 열립니다.' })));
    hideSplash();
    return;
  }
  // The menu bar starts open unless it would cover the list (UX 0-48).
  state.navOpen = !coverQuery.matches;
  mountTooltips(root);
  applyNarrow();
  new ResizeObserver(() => fitList(content)).observe(content);
  mountPlayer();
  platform.search?.onDownload?.((download) => { state.download = download; renderStrip(); });
  app.chat = mountChat(chatPane, {
    platform,
    sounds: () => state.sounds,
    packs: () => state.packs,
    play: (sound, bytes) => toggle(sound, { ...chatStart(), bytes }),
    isPlaying,
    lengthText,
    startDrag,
    prepareDrag,
    droppedSound,
    showError,
    autoplay: () => state.autoplay,
    analysing,
    rowMenu: openRowMenu,
    openPack,
  });
  void preloadModels();
  const api = platform.connections;
  if (api) {
    api.onChange((folders) => {
      const finished = state.folders.some((folder) => folder.status !== 'completed') && folders.every((folder) => folder.status === 'completed');
      state.folders = folders;
      if (state.route.view === 'settings') void loadTracking();
      if (finished) {
        // Analysis just ended: load the final durations and waveforms now instead of after the throttle.
        clearTimeout(soundTimer);
        void loadSounds(true);
        void loadCategories();
      } else scheduleSounds();
      // Analysis reports every file, so the list stays put and only the bottom strip follows it.
      if (state.route.view === 'settings' || !state.sounds.length) render(); else renderStrip();
    });
    try { state.folders = await api.getFolders(); } catch { state.folders = []; }
  }
  try { if (platform.collections) state.collections = await platform.collections.load(); } catch { showError('즐겨찾기와 모음을 불러오지 못했습니다.'); }
  render();
  await loadSounds();
  hideSplash();
  void loadCategories();
  if (state.sounds.length) list.focus();
}

// Automation only: the app has no button that deletes a collection, so a check takes one away here.
if (new URLSearchParams(location.search).get('proto1-test-state') === '1') Object.assign(window, { __proto1State: state, __proto1Render: render });

app.render = render;
app.refreshList = list.refresh;
app.reveal = (sound) => list.reveal(state.visible.indexOf(sound));
app.showError = showError;
app.focusList = list.focus;
app.nameCollection = nameCollection;
void start();
