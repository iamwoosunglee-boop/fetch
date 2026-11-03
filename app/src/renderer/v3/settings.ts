import type { LibraryConnection } from '../../platform/types';
import { h, iconButton, midPath } from './dom';
import { fileName, shortPath } from './format';
import { icon } from './icons';
import { app, platform, saveAutoplay, state, web } from './state';

const EXAMPLE_SOUNDS_URL = 'https://github.com/iamwoosunglee-boop/fetch/releases/latest/download/fetch-example-sounds.zip';

export async function chooseFolder(): Promise<void> {
  const api = platform.connections;
  if (!api) return;
  try {
    const folder = await api.chooseFolder();
    if (folder) await api.connectFolder(folder);
  } catch (error) {
    app.showError(error instanceof Error ? error.message : '폴더를 연결하지 못했습니다.');
  }
}

export function firstRun(): HTMLElement {
  const zone = h('div', { class: 'dropzone' }, icon('folder', 30), h('p', { text: '소리 폴더를 여기에 끌어다 놓거나 선택하세요' }),
    h('button', { class: 'primary', type: 'button', on: { click: () => void chooseFolder() } }, '폴더 선택하기'),
    web ? h('a', { class: 'eg', text: '소리 폴더가 없으면 예시 소리를 다운로드하세요', attrs: { href: EXAMPLE_SOUNDS_URL, target: '_blank', rel: 'noreferrer' } }) : null);
  zone.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); zone.classList.add('over'); } });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', () => zone.classList.remove('over'));
  return h('div', { class: 'dropwrap', dataset: { odId: 'first-run' } }, zone);
}

export async function loadTracking(): Promise<void> {
  const tracking = platform.connections?.tracking;
  if (!tracking) return;
  try {
    state.tracking = await tracking.load();
    if (state.route.view === 'settings') app.render();
  } catch { app.showError('파일 기록을 불러오지 못했습니다.'); }
}

function trackingView(): HTMLElement[] {
  const view = state.tracking;
  const tracking = platform.connections?.tracking;
  if (!view || !tracking) return [];
  const parts: HTMLElement[] = [];
  if (view.questions.length) {
    parts.push(h('div', { class: 'track' }, h('h3', { text: `내용이 바뀐 파일 ${view.questions.length.toLocaleString('ko-KR')}개` }),
      ...view.questions.map((question) => h('div', { class: 'track-row' },
        h('span', { class: 'names' }, h('span', { class: 'fname', text: fileName(question.path), title: question.path }), h('span', { class: 'pack', text: `이전 분류 ${question.decision}` })),
        h('div', { class: 'acts' },
          h('button', { class: 'btn sm', type: 'button', on: { click: () => void tracking.answer(question.path, true).then(loadTracking) } }, '이전 분류 사용'),
          h('button', { class: 'btn sm', type: 'button', on: { click: () => void tracking.answer(question.path, false).then(loadTracking) } }, '이전 분류 버리기'))))));
  }
  const group = (title: string, rows: string[][]) => h('details', { class: 'track' },
    h('summary', {}, icon('right', 13), h('span', {}, `${title} `, h('span', { class: 'num', text: rows.length.toLocaleString('ko-KR') }), '개')),
    ...rows.map((lines) => h('div', { class: 'track-row' }, h('span', { class: 'names' }, ...lines.map((line, index) => h('span', { class: index ? 'pack' : 'fname', text: line, title: line }))))));
  // Paths below the connected folder, so a row reads like the folder the person picked.
  const short = (file: string) => {
    const folder = state.folders.find((item) => file.startsWith(`${item.root}/`) || file.startsWith(`${item.root}\\`));
    return folder ? `${fileName(folder.root)}/${file.slice(folder.root.length + 1)}` : file;
  };
  if (view.missing.length) parts.push(group('사라진 파일', view.missing.map((file) => [...file.paths.map(short), ...(file.decision ? [`분류 ${file.decision}`] : [])])));
  if (view.moved.length) parts.push(group('이동한 파일', view.moved.map((file) => [short(file.to), `${short(file.from)}에서 이동`])));
  if (view.duplicates.length) parts.push(group('중복 파일', view.duplicates.map((paths) => paths.map(short))));
  return parts;
}

function folderStatus(folder: LibraryConnection): HTMLElement {
  const st = h('div', { class: 'st' });
  if (folder.needsPermission) st.append(h('span', { class: 'bad', text: '폴더 접근을 다시 허용해야 합니다. 다시 허용을 눌러 주세요.' }));
  else if (folder.status === 'stopped' && folder.failure === 'model') st.append(h('span', { class: 'bad', text: '분석 자료를 다운로드하지 못했습니다' }));
  else if (folder.status === 'stopped') st.append(h('span', { class: 'bad', text: shortPath(folder.reason ?? '분석이 멈췄습니다') }));
  else if (folder.status === 'scanning') st.append(h('span', { text: '폴더 확인 중' }));
  else if (folder.status === 'indexing') {
    const done = folder.completed + folder.failed + folder.skipped;
    st.append(h('span', {}, '소리 분석 중 ', h('span', { class: 'num', text: `${done.toLocaleString('ko-KR')} / ${folder.fileCount.toLocaleString('ko-KR')}` })),
      h('span', { class: 'bar' }, h('i', { style: `width:${folder.fileCount ? (done / folder.fileCount) * 100 : 0}%` })));
  } else st.append(h('span', { text: folder.failed ? `분석 완료, 읽지 못한 소리 ${folder.failed.toLocaleString('ko-KR')}개` : '분석 완료' }));
  return st;
}

function toggleAutoplay(event: MouseEvent): void {
  state.autoplay = !state.autoplay;
  saveAutoplay();
  const toggle = event.currentTarget as HTMLElement;
  toggle.classList.toggle('on', state.autoplay);
  toggle.setAttribute('aria-checked', String(state.autoplay));
}

export function settingsView(): HTMLElement[] {
  const api = platform.connections;
  const rows = state.folders.map((folder) => {
    const name = folder.root.split(/[\\/]/).filter(Boolean).pop() ?? folder.root;
    const asking = folder.needsPermission && api?.reauthorize;
    const row = h('div', { class: 'li' }, icon('folder', 18),
      h('span', { class: 'names' }, h('span', { class: 'fname' }, midPath(web ? name : shortPath(folder.root), folder.root)),
        folder.status === 'scanning' && !folder.fileCount ? null : h('span', { class: 'pack' }, `소리 ${folder.fileCount.toLocaleString('ko-KR')}개`)),
      folderStatus(folder),
      // The web keeps a column for 다시 허용, the one recovery that stays a word.
      !web ? null : asking ? h('button', { class: 'btn', type: 'button', on: { click: () => void asking(folder.root).catch((error) => app.showError(String(error?.message ?? error))) } }, '다시 허용') : h('span'),
      asking ? h('span') : iconButton(icon('refresh', 16), '다시 확인', () => void api?.rescanFolder(folder.root).catch((error) => app.showError(String(error?.message ?? error))), 'ib recheck'),
      iconButton(icon('unlink', 16), `${name} 연결 해제`, () => void (confirm(`${name} 폴더 연결을 해제할까요?`) ? api?.removeFolder(folder.root) : undefined)?.catch((error) => app.showError(String(error?.message ?? error))), 'ib unlink'));
    row.addEventListener('pointerenter', () => row.classList.add('hot'));
    row.addEventListener('pointerleave', () => row.classList.remove('hot'));
    return row;
  });
  return [h('div', { class: 'head' }, h('h1', { text: '설정' })), h('div', { class: 'set' },
    h('div', { class: 'set-top' }, h('h2', { text: '라이브러리 폴더' }),
      h('button', { class: 'btn', type: 'button', on: { click: () => void chooseFolder() } }, icon('plus', 14), '폴더 추가하기')),
    ...(rows.length ? [h('div', { class: 'lib' }, ...rows), ...trackingView()] : [firstRun()]),
    h('h2', { text: '재생' }),
    h('div', { class: 'set-row' }, h('span', { class: 'names' }, h('span', { class: 'fname', text: '위아래 키로 이동할 때 바로 재생' })),
      h('button', { class: `toggle${state.autoplay ? ' on' : ''}`, type: 'button', attrs: { role: 'switch', 'aria-checked': String(state.autoplay), 'aria-label': '자동 재생' }, on: { click: toggleAutoplay } }, h('i'))))];
}

