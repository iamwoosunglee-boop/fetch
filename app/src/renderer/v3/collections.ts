import type { SearchSound } from '../../core/search';
import { addEntry, inCollection, removeEntry, soundEntry, type CollectionData } from '../../core/collections';
import { h } from './dom';
import { carriesSound, droppedSound } from './drag';
import { icon } from './icons';
import { menuItem, popover, submenuItem } from './menus';
import { app, favorites, logSound, platform, state } from './state';

export async function saveCollections(next: CollectionData): Promise<void> {
  state.collections = next;
  app.render();
  try { await platform.collections?.save(next); }
  catch { app.showError('즐겨찾기와 모음을 저장하지 못했습니다.'); }
}

export function toggleFavorite(sound: SearchSound): void {
  if (!sound.fullHash) return;
  const set = favorites();
  if (set.has(sound.fullHash)) set.delete(sound.fullHash); else set.add(sound.fullHash);
  void saveCollections({ ...state.collections, favorites: [...set] });
}

export function addToCollection(collectionId: string, sound: SearchSound): void {
  const entry = soundEntry(sound);
  if (!entry) return;
  logSound('collection', sound);
  void saveCollections({
    ...state.collections,
    collections: state.collections.collections.map((item) => item.id === collectionId ? { ...item, entries: addEntry(item.entries, entry) } : item),
  });
}

export function removeFromCollection(collectionId: string, sound: SearchSound): void {
  const entry = soundEntry(sound);
  if (!entry) return;
  void saveCollections({
    ...state.collections,
    collections: state.collections.collections.map((item) => item.id === collectionId ? { ...item, entries: removeEntry(item.entries, entry) } : item),
  });
}

/** A collection named from a row's menu starts with that row's sound. */
export function createCollection(name: string, sound?: SearchSound): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const id = `c${Date.now().toString(36)}`;
  const entry = sound && soundEntry(sound);
  if (sound && entry) logSound('collection', sound);
  void saveCollections({ ...state.collections, collections: [...state.collections.collections, { id, name: trimmed, entries: entry ? [entry] : [] }] });
}

/** Makes an element a place to drop sounds for a collection. */
export function acceptSounds(element: HTMLElement, collectionId: string): void {
  element.addEventListener('dragover', (event) => { if (carriesSound(event)) { event.preventDefault(); element.classList.add('over'); } });
  element.addEventListener('dragleave', () => element.classList.remove('over'));
  element.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('over');
    void droppedSound(event).then((dropped) => {
      if (dropped && !(dropped instanceof File)) addToCollection(collectionId, dropped);
      else if (dropped) app.showError('라이브러리에 있는 소리만 모음에 추가할 수 있습니다.');
    });
  });
}

const collectionItems = (sound: SearchSound) => [
  ...state.collections.collections.map((collection) => {
    const holds = inCollection(collection, sound);
    return menuItem(collection.name, () => (holds ? removeFromCollection : addToCollection)(collection.id, sound), undefined,
      holds ? h('span', { class: 'ck' }, icon('check', 16)) : undefined);
  }),
  ...(state.collections.collections.length ? [h('hr')] : []),
  menuItem('새 모음', () => app.nameCollection(sound), undefined, icon('plus', 16)),
];

export function openRowMenu(anchor: HTMLElement, sound: SearchSound): void {
  const liked = Boolean(sound.fullHash && favorites().has(sound.fullHash));
  const items = [
    menuItem(liked ? '즐겨찾기 해제' : '즐겨찾기', () => toggleFavorite(sound), undefined, icon('heart', 16)),
    submenuItem('모음에 추가', icon('stack', 16), () => collectionItems(sound)),
  ];
  const { route } = state;
  const current = route.view === 'collection' ? state.collections.collections.find((item) => item.id === route.id) : undefined;
  if (current && inCollection(current, sound)) items.push(menuItem('이 모음에서 제거', () => removeFromCollection(current.id, sound), undefined, icon('x', 16)));
  const reveal = platform.search?.reveal;
  if (reveal) items.push(menuItem('Finder에서 보기', () => { void reveal(sound).catch((error) => app.showError(String(error?.message ?? error))); }, undefined, icon('folder', 16)));
  popover(anchor, 'menu', items);
}
