import type { DownloadState } from '../../model/download';
import { clear, h, midPath } from './dom';
import { fileName, shortPath } from './format';
import { icon } from './icons';
import { platform, state, web } from './state';

export const strip = h('div', { class: 'strip', attrs: { role: 'status' } });

const failure = (message: string) => h('span', { class: 'err' }, icon('alert', 13), message);
const action = (label: string, run: () => void) => h('button', { class: 'btn sm', type: 'button', text: label, on: { click: run } });

function folderProblems(retryModels: () => void): HTMLElement[] {
  const items: HTMLElement[] = [];
  if (state.error) items.push(failure(state.error));
  for (const folder of state.folders) {
    const name = folder.root.split(/[\\/]/).filter(Boolean).pop() ?? folder.root;
    if (folder.needsPermission) items.push(failure(`${name} 폴더에 다시 접근하려면 허용해 주세요.`), action('다시 허용', () => void platform.connections?.reauthorize?.(folder.root)));
    else if (folder.offline) items.push(failure(`${name} 폴더를 찾을 수 없습니다. 드라이브를 연결해 주세요.`), action('다시 확인', () => void platform.connections?.rescanFolder(folder.root)));
    else if (folder.status === 'stopped' && folder.failure === 'model') items.push(failure('분석 자료를 다운로드하지 못했습니다. 인터넷 연결을 확인해 주세요.'), action('다시 시도', () => void platform.connections?.rescanFolder(folder.root)));
  }
  if (state.models === 'failed' && !items.length) items.push(failure('분석 자료를 다운로드하지 못했습니다. 인터넷 연결을 확인해 주세요.'), action('다시 시도', retryModels));
  return items;
}

const downloadItems = ({ percent }: DownloadState) => [h('span', { text: '분석 자료 다운로드 중' }),
  ...(percent === undefined ? [] : [h('span', { class: 'num', text: `${percent}%` }), h('span', { class: 'bar' }, h('i', { style: `width:${percent}%` }))])];

/** One element per path: progress redraws the strip for every sound, and a new element would lose its tooltip each time. */
let place: { shown: string; element: HTMLElement } | undefined;
function folderPlace(root: string): HTMLElement {
  const shown = web || state.narrow ? fileName(root) : shortPath(root);
  if (place?.shown !== shown) place = { shown, element: midPath(shown, root) };
  return place.element;
}

export function renderStrip(retryModels: () => void): void {
  clear(strip);
  const { folders } = state;
  const items = folderProblems(retryModels);
  const scanning = folders.filter((folder) => folder.status === 'scanning');
  const indexing = folders.filter((folder) => folder.status === 'indexing');
  const waiting = folders.find((folder) => folder.download)?.download;
  const preloading = state.models === 'loading' ? state.download : undefined;
  if (!items.length && scanning.length) {
    const known = scanning.reduce((sum, folder) => sum + folder.fileCount, 0);
    items.push(h('span', { text: '폴더 확인 중' }), ...(known ? [h('span', { class: 'num', text: known.toLocaleString('ko-KR') })] : []));
  }
  else if (!items.length && waiting) items.push(...downloadItems(waiting));
  else if (!items.length && indexing.length) {
    const done = indexing.reduce((sum, folder) => sum + folder.completed + folder.failed + folder.skipped, 0);
    const total = indexing.reduce((sum, folder) => sum + folder.fileCount, 0);
    const current = indexing.find((folder) => folder.current);
    items.push(h('span', { text: '소리 분석 중' }), h('span', { class: 'num', text: `${done.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')}` }),
      h('span', { class: 'bar' }, h('i', { style: `width:${total ? (done / total) * 100 : 0}%` })), ...(current ? [folderPlace(current.root)] : []), ...(preloading ? downloadItems(preloading) : []));
  } else if (!items.length && preloading) items.push(...downloadItems(preloading));
  strip.hidden = !items.length;
  strip.append(...items);
}
