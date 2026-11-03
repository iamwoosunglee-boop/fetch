import { KOREAN_NAMES } from '../../core/classify/labels';
import { acceptSounds } from './collections';
import { h } from './dom';
import { anyFilter, countLabel, filterBar, filteredSounds, narrowed, routeCollection, scopeSounds, searchFinds } from './filters';
import { icon } from './icons';
import { lengthBuckets, packSummary, rangeLabel, sortSounds, topKinds, type PackInfo } from './library';
import { navigate, openPack, releaseChips, searchInput } from './navigation';
import { list } from './rows';
import { chooseFolder, firstRun } from './settings';
import { analysing, app, platform, sortKey, state } from './state';
import { tile } from './tile';

const heading = (title: string, count?: Node | null, end?: Node | null) =>
  h('div', { class: 'head' }, h('h1', { text: title }), count ?? null, end ?? null);

const noneWith = (message: string, label?: string, action?: () => void) => h('div', { class: 'none' }, h('p', { text: message }),
  label ? h('button', { class: 'btn sm', type: 'button', text: label, on: { click: action } }) : null);

function emptyResult(): HTMLElement {
  const { filters, route } = state;
  const query = filters.query.trim();
  const collection = routeCollection();
  if (query && !(anyFilter() && searchFinds())) {
    return noneWith(`"${query}" 검색 결과가 없습니다.`, '검색 지우기', () => navigate(() => { filters.query = ''; searchInput.value = ''; }));
  }
  if (!anyFilter() && route.view === 'favorites') return noneWith('즐겨찾기한 소리가 없습니다.');
  if (!anyFilter() && collection) {
    const zone = noneWith('모음이 비어 있습니다.');
    acceptSounds(zone, collection.id);
    return zone;
  }
  const kind = filters.kinds.size === 1 ? (KOREAN_NAMES[[...filters.kinds][0]] ?? [...filters.kinds][0]) : '';
  const span = filters.range ? rangeLabel(filters.range) : lengthBuckets.find((item) => item.id === filters.length)?.label;
  // A pack or favorite filter is part of the reason too, so naming only the kind and length would be wrong.
  const others = query || filters.packs.size > 0 || filters.favorites;
  const subject = others ? '' : [kind && `${kind} 중에`, span && `${span}인`].filter(Boolean).join(' ');
  return noneWith(`${subject ? `${subject} ` : '조건에 맞는 '}소리가 없습니다.`, '필터 해제', () => navigate(releaseChips));
}

function screenTitle(): string {
  const { route, filters } = state;
  const collection = routeCollection();
  if (collection) return collection.name;
  const query = filters.query.trim();
  if (query) return `"${query}" 검색 결과`;
  return route.view === 'favorites' ? '즐겨찾기' : '모든 소리';
}

function packHead(pack: PackInfo): HTMLElement {
  const sounds = scopeSounds();
  const kinds = topKinds(sounds, state.categories);
  const reveal = platform.packs?.revealLicense;
  const facts = [pack.creator, pack.license, pack.source?.replace(/^https?:\/\//, '')];
  const hasFacts = facts.some(Boolean) || (pack.licenseFile && reveal);
  return h('div', { class: 'packtop' },
    h('span', { class: 'cover' }, tile(pack)),
    h('div', { class: 'packinfo' },
      h('div', { class: 'pname' }, h('h1', { text: pack.name }), pack.full === pack.name ? null : h('span', { class: 'pfull', text: pack.full }), narrowed() ? countLabel(state.visible.length) : null),
      h('p', { class: 'pstat', text: packSummary(sounds) }),
      kinds.length ? h('div', { class: 'ptags' }, ...kinds.map(([kind, count]) => h('span', { class: 'cond' }, `${KOREAN_NAMES[kind] ?? kind} ${kind} `, h('span', { class: 'num', text: count.toLocaleString('ko-KR') })))) : null,
      hasFacts ? h('div', { class: 'pmeta' },
        ...facts.flatMap((fact, index) => (fact ? [h('span', { class: index === 2 ? 'src' : '', text: fact })] : [])),
        pack.licenseFile && reveal ? h('button', { class: 'btn', type: 'button', text: 'Finder에서 보기', on: { click: () => void reveal(pack.id).catch((error) => app.showError(String(error?.message ?? error))) } }) : null) : null));
}

export function listView(): HTMLElement[] {
  const { route } = state;
  state.visible = sortSounds(filteredSounds(), sortKey(), state.packs);
  if (!state.folders.length && !state.sounds.length) return [heading(screenTitle()), filterBar(), firstRun()];
  const noSounds = state.loaded && !state.sounds.length;
  // Finished folders without a single file will never fill the list.
  if (noSounds && state.folders.every((folder) => folder.status === 'completed' && !folder.fileCount)) {
    return [heading(screenTitle()), filterBar(0), noneWith('연결한 폴더에 소리 파일이 없습니다.', '폴더 선택하기', () => void chooseFolder())];
  }
  const pack = route.view === 'pack' ? state.packs.get(route.id) : undefined;
  const head = pack ? packHead(pack) : heading(screenTitle(), noSounds ? null : countLabel(state.visible.length));
  if (noSounds) return [head, filterBar(0), h('div', { class: 'none' }, analysing() ? h('p', { text: '폴더를 확인하고 있습니다.' }) : null)];
  return [head, filterBar(state.visible.length), state.visible.length ? list.element : emptyResult()];
}

export function packsView(): HTMLElement[] {
  const packs = [...state.packs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const cards = packs.map((pack) => h('button', { class: 'pk', type: 'button', attrs: { 'aria-label': pack.full }, on: { click: () => openPack(pack.id) } },
    h('span', { class: 'art-lg' }, tile(pack)),
    h('span', { class: 'names' }, h('span', { class: 'fname', text: pack.name }), h('span', { class: 'pack' }, '소리 ', h('span', { class: 'num', text: pack.count.toLocaleString('ko-KR') }), '개'))));
  return [heading('팩', h('span', { class: 'count' }, '팩 ', h('span', { class: 'num', text: packs.length.toLocaleString('ko-KR') }), '개'), h('span', { class: 'sort end' }, icon('sort', 14), h('span', { text: '이름순' }))),
    cards.length ? h('div', { class: 'packs' }, ...cards) : h('div', { class: 'none' }, h('p', { text: '아직 팩이 없습니다.' }))];
}
