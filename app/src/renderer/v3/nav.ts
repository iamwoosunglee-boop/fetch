import type { SearchSound } from '../../core/search';
import { acceptSounds, createCollection } from './collections';
import { clear, h, iconButton, imeKey } from './dom';
import { icon, type IconName } from './icons';
import { navigate } from './navigation';
import { loadTracking } from './settings';
import { app, state, type Route } from './state';

export const nav = h('nav', { class: 'nav', attrs: { 'aria-label': '메뉴' } });

/** The sound whose row menu asked for the collection being named. */
let namedFor: SearchSound | undefined;

export function go(route: Route): void {
  navigate(() => {
    state.route = route;
    if (state.cover) {
      state.navOpen = false;
      state.chatOpen = false;
    }
  });
  if (route.view === 'settings') void loadTracking();
}

const isCurrent = (route: Route) => state.route.view === 'pack' ? route.view === 'packs' : JSON.stringify(route) === JSON.stringify(state.route);

function item(route: Route, label: string, iconName?: IconName, extra = ''): HTMLButtonElement {
  const current = isCurrent(route);
  return h('button', {
    class: `nav-i${extra}${current ? ' on' : ''}`, type: 'button', attrs: { 'aria-current': current ? 'page' : undefined }, on: { click: () => go(route) },
  }, iconName ? icon(iconName, 18) : '', h('span', { text: label }));
}

export function renderNav(): void {
  // Rebuilding would drop the name being typed, and any syllable the input method still holds.
  if (document.activeElement?.classList.contains('nav-new')) return;
  clear(nav);
  const collections = state.collections.collections.map((collection) => {
    const button = item({ view: 'collection', id: collection.id }, collection.name, undefined, ' nav-c');
    acceptSounds(button, collection.id);
    return button;
  });
  const naming = h('input', { class: 'nav-new', attrs: { placeholder: '새 모음 이름', 'aria-label': '새 모음 이름', hidden: true } });
  const finish = (save: boolean) => {
    const name = naming.value;
    const sound = namedFor;
    namedFor = undefined;
    naming.value = '';
    naming.blur();
    naming.hidden = true;
    if (save) createCollection(name, sound);
  };
  naming.addEventListener('keydown', (event) => {
    if (imeKey(event) || (event.key !== 'Enter' && event.key !== 'Escape')) return;
    finish(event.key === 'Enter');
    if (state.cover) { state.navOpen = false; app.render(); }
    app.focusList();
  });
  // A click elsewhere keeps what was typed; leaving the app for a moment changes nothing.
  naming.addEventListener('blur', () => { if (document.hasFocus()) finish(true); });
  nav.append(
    item({ view: 'all' }, '모든 소리', 'all'),
    item({ view: 'favorites' }, '즐겨찾기', 'heart'),
    h('div', { class: 'nav-h' }, h('span', { text: '모음' }), iconButton(icon('plus', 16), '새 모음', () => nameCollection())),
    naming,
    ...collections,
    h('div', { class: 'nav-gap' }),
    item({ view: 'packs' }, '팩', 'packs'),
    h('div', { class: 'spacer' }),
    item({ view: 'settings' }, '설정', 'gear'),
  );
}

export function nameCollection(sound?: SearchSound): void {
  namedFor = sound;
  state.navOpen = true;
  app.render();
  const naming = nav.querySelector<HTMLInputElement>('.nav-new');
  if (!naming) return;
  naming.hidden = false;
  naming.focus();
}
