// allow: SIZE_OK - One panel closure owns the input, the reply target, the cursor and the redraw of every answer.
import {
  answerLines, answerWarns, createChatStore, maxRequestLength, referenceFor, sentences,
  type ChatAnswer, type ChatReference, type ChatState, type ChatStore, type ChatTab, type ChatUserMessage,
} from '../../core/chat';
import type { RankedSound, SearchSound } from '../../core/search';
import type { Platform } from '../../platform/types';
import { clear, h, iconButton, imeKey } from './dom';
import { icon, mark } from './icons';
import { fileName, packNameOf, seconds } from './format';
import type { PackInfo } from './library';
import { tile } from './tile';

const PROMPT = '소리를 설명하거나 파일을 끌어다 놓으세요';

/** A length range stays on one line: the browser would break it after the hyphen. */
const flowMs = 1_600;

/** The sentence fades in word by word, then the rest rises in turn. Times live in CSS variables. */
function flowIn(view: HTMLElement, lines: readonly HTMLElement[], age: number): void {
  let words = 0;
  for (const line of lines) {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      node.replaceWith(...(node.textContent ?? '').split(/(\s+)/u).map((part) => {
        if (!part.trim()) return part;
        const word = h('span', { class: 'fw', text: part });
        word.style.setProperty('--i', String(words++));
        return word;
      }));
    }
  }
  const step = Math.min(30, 450 / Math.max(words, 1));
  view.classList.add('flow');
  view.style.setProperty('--t', `${-age}ms`);
  view.style.setProperty('--step', `${step}ms`);
  view.style.setProperty('--rows', `${Math.round(words * step) + 120}ms`);
  const later = Array.from(view.children).flatMap((child) => {
    if (lines.includes(child as HTMLElement)) return [];
    return child.matches('.cres') ? Array.from(child.children) : [child];
  });
  later.forEach((item, index) => {
    item.classList.add('flow-in');
    (item as HTMLElement).style.setProperty('--r', String(index));
  });
}

const sentence = (line: string) => h('span', {}, ...line.split(/(\d+(?:\.\d+)?-\d+(?:\.\d+)?초)/u)
  .map((part, index) => (index % 2 ? h('span', { class: 'nb', text: part }) : part)));

export interface ChatDeps {
  platform: Platform;
  sounds: () => readonly SearchSound[];
  packs: () => ReadonlyMap<string, PackInfo>;
  /** bytes reads a sound from outside the library. */
  play: (sound: SearchSound, bytes?: () => Promise<ArrayBuffer>) => void;
  isPlaying: (sound: SearchSound) => boolean;
  lengthText: (sound: SearchSound) => string;
  startDrag: (event: DragEvent, sound: SearchSound) => void;
  prepareDrag: (sound: SearchSound) => void;
  droppedSound: (event: DragEvent) => Promise<SearchSound | File | undefined>;
  showError: (message: string) => void;
  /** The setting that decides whether moving with the up and down keys plays right away. */
  autoplay: () => boolean;
  analysing: () => boolean;
  rowMenu: (anchor: HTMLElement, sound: SearchSound) => void;
  openPack: (packId: string) => void;
}

export interface ChatHandle {
  refresh(): void;
  focus(): void;
  /** The result rows in panel order, so the player's next button can follow them. */
  results(): SearchSound[];
  /** The result the arrow keys are on. */
  selected(): SearchSound | undefined;
  /** The newest answer that showed this sound. */
  answerOf(sound: SearchSound): string | undefined;
  store?: ChatStore;
}

export function mountChat(container: HTMLElement, deps: ChatDeps): ChatHandle {
  const search = deps.platform.search;
  if (!search) return { refresh() {}, focus() {}, results: () => [], selected: () => undefined, answerOf: () => undefined };
  const store = createChatStore({
    platform: search, sounds: deps.sounds, analysing: deps.analysing,
    packName: (sound) => deps.packs().get(sound.packId)?.name ?? packNameOf(sound),
    reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
  const web = deps.platform.kind === 'web';
  let replyTo: { answerId: string; soundId?: string; label: string } | undefined;
  /** A sound dropped on the panel: it waits above the input until the person sends. */
  let attached: ChatReference | undefined;
  /** Files from outside the library by hash, kept while the app is open so they can be heard. */
  const outsideFiles = new Map<string, File>();
  /** The result the arrow keys are on; it outlives playback, so the keys also move with the 재생 setting off. */
  let cursor: string | undefined;

  const input = h('input', { class: 'compose-input', attrs: { placeholder: PROMPT, 'aria-label': 'fetch ai에게 보낼 요청' } });
  const sendButton = iconButton(icon('enter', 16), '보내기', () => submit(), 'send');
  sendButton.disabled = true;
  const syncSend = () => { sendButton.disabled = !input.value.trim() && !attached; };
  const compose = h('form', { class: 'compose' }, input, sendButton);
  compose.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  container.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.length) { event.preventDefault(); compose.classList.add('over'); }
  });
  container.addEventListener('dragleave', (event) => { if (!container.contains(event.relatedTarget as Node | null)) compose.classList.remove('over'); });
  container.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    compose.classList.remove('over');
    void deps.droppedSound(event).then(async (dropped) => {
      if (!dropped) return;
      let reference: ChatReference;
      if (dropped instanceof File) {
        try {
          const imported = await search.importReference(dropped);
          reference = { name: imported.name, duration: imported.duration, embedding: imported.embedding, fullHash: imported.fullHash };
          if (imported.fullHash) outsideFiles.set(imported.fullHash, dropped);
        } catch {
          deps.showError('이 파일은 읽지 못했어요. WAV, MP3, OGG, FLAC 파일인지 확인해 주세요.');
          return;
        }
      } else reference = referenceFor(dropped);
      attached = reference;
      syncSend();
      render(store.getState());
      input.focus();
    });
  });

  const tabsBar = h('div', { class: 'tabs' });
  const pinnedBar = h('div', { class: 'pinned' });
  const messages = h('div', { class: 'msgs', attrs: { tabindex: '-1' } });
  const attach = h('div', { class: 'attach' });
  const attachedRow = h('div', { class: 'attach' });
  const limit = h('p', { class: 'compose-note', text: sentences.tooLong, attrs: { role: 'status', hidden: true } });
  // Outside the redrawn answers, so a screen reader hears the first waiting line once and none of the rotation.
  const spoken = h('p', { class: 'spoken', attrs: { role: 'status' } });
  container.append(tabsBar, pinnedBar, messages, attach, attachedRow, limit, compose, spoken);
  input.addEventListener('input', () => {
    syncSend();
    if (input.value.trim().length <= maxRequestLength) limit.hidden = true;
  });

  function send(text: string, reference?: ChatReference): void {
    input.focus();
    if (!text && !reference) return;
    if (text.length > maxRequestLength) { limit.hidden = false; return; }
    const target = replyTo;
    replyTo = undefined;
    attached = undefined;
    input.value = '';
    syncSend();
    void store.send({ text, reference, replyTo: target && { answerId: target.answerId, soundId: target.soundId } });
    render(store.getState());
  }

  function submit(): void {
    send(input.value.trim(), attached);
  }

  const shortRequest = (text: string) => (text.length > 20 ? `${text.slice(0, 19)}…` : text);

  const soundOf = (item: RankedSound) => deps.sounds().find((sound) => sound.id === item.sound.id) ?? item.sound;

  /** The person's words for Haiku's English sentences: the request whose answer first carried them. */
  function requestLabel(tab: ChatTab, sentences: readonly string[]): string | undefined {
    const key = JSON.stringify(sentences);
    let text = '';
    for (const message of tab.messages) {
      if (message.kind === 'user') text = message.text.trim();
      else if (text && JSON.stringify(message.conditions.sentences) === key) return shortRequest(text);
    }
    return undefined;
  }

  const conditionChip = (label: string, remove: () => void) =>
    h('span', { class: 'cond' }, h('span', { text: label }), iconButton(icon('x', 10), `${label} 제거`, remove, 'cond-x'));

  function listen(sound: SearchSound): void {
    cursor = sound.id;
    deps.play(sound);
  }

  function resultRow(answer: ChatAnswer, item: RankedSound, index: number): HTMLLIElement {
    const sound = soundOf(item);
    const name = fileName(sound.relativePath);
    const pack = deps.packs().get(sound.packId);
    const classes = `crow${deps.isPlaying(sound) ? ' now' : ''}${cursor === sound.id ? ' sel' : ''}${answer.cuts.includes(index) ? ' cut' : ''}`;
    const row = h('li', { class: classes, dataset: { id: sound.id }, attrs: { draggable: sound.blockedReason ? undefined : 'true' } },
      iconButton(icon(deps.isPlaying(sound) ? 'pause' : 'play', 13), `${name} ${deps.isPlaying(sound) ? '일시 정지' : '재생'}`, (event) => { event.stopPropagation(); listen(sound); }, 'ib play'),
      h('span', { class: 'names' }, h('span', { class: 'fname', text: name }),
        h('button', { class: 'pack', type: 'button', text: pack?.name ?? sound.packName ?? '', attrs: { 'aria-label': pack?.full }, on: { click: (event) => { event.stopPropagation(); deps.openPack(sound.packId); } } })),
      h('span', { class: 'num dur', text: deps.lengthText(sound) }),
      web && search?.download ? iconButton(icon('dl', 14), '다운로드', (event) => { event.stopPropagation(); void search.download!(sound).catch(() => deps.showError('소리를 다운로드하지 못했습니다.')); }, 'ib dl') : null,
      iconButton(icon('reply', 14), `${name}에 답장`, (event) => {
        event.stopPropagation();
        replyTo = { answerId: answer.id, soundId: sound.id, label: name };
        render(store.getState());
        input.focus();
      }, 'ib rp'),
      iconButton(icon('more', 14), '메뉴', (event) => { event.stopPropagation(); deps.rowMenu(event.currentTarget as HTMLElement, sound); }, 'ib mb'));
    row.addEventListener('click', () => listen(sound));
    row.addEventListener('pointerenter', () => deps.prepareDrag(sound));
    row.addEventListener('dragstart', (event) => deps.startDrag(event, sound));
    return row;
  }

  /** When each answer began to appear; redraws read it so a running animation carries on where it was. */
  const flows = new Map<string, number>();

  function flowAge(id: string, working: boolean): number | undefined {
    if (working) { flows.set(id, 0); return undefined; }
    const began = flows.get(id);
    if (began === undefined) return undefined;
    if (began === 0) { flows.set(id, performance.now()); return 0; }
    const age = performance.now() - began;
    if (age < flowMs) return age;
    flows.delete(id);
    return undefined;
  }

  function answerView(answer: ChatAnswer, busy: boolean): HTMLElement {
    // The daily limit is a fact with its own way forward, not a failure to try again.
    const failed = answerWarns(answer) && answer.canRetry;
    const working = answer.status === 'pending' || answer.writing;
    // The ball holds the sentence's place: under the reason, above the notes and the results.
    const ballAt = !working ? -1 : answer.reason ? 1 : 0;
    const parts = answerLines(answer).map((line, index) => {
      const first = index === 0 && ballAt !== 0;
      return h('div', { class: `say${!first ? ' next' : failed ? ' err' : ''}` }, !first ? '' : failed ? icon('alert', 16) : mark(16), sentence(line));
    });
    if (working) {
      parts.splice(ballAt, 0, h('div', { class: 'dots', attrs: { role: 'img', 'aria-label': '소리를 찾는 중' } },
        mark(20, 'fetching'), answer.waiting ? h('span', { text: answer.waiting }) : null));
    }
    const view = h('div', { class: 'ans', dataset: { answer: answer.id } }, ...parts);
    // The sentence comes first: results stay hidden until it is there.
    if (answer.results.length && !working) view.append(h('ul', { class: 'cres' }, ...answer.results.map((item, index) => resultRow(answer, item, index))));
    if (answer.closing) view.append(h('div', { class: 'say' }, mark(16), h('span', { text: answer.closing })));
    const buttons: HTMLElement[] = [];
    if (!working && answer.canMore) buttons.push(h('button', { class: 'btn sm', type: 'button', on: { click: () => void store.more(answer.id) } }, '더 보기'));
    if (answer.status !== 'pending' && answer.canRelaxLength) buttons.push(h('button', { class: 'btn sm', type: 'button', on: { click: () => void store.relaxLength(answer.id) } }, '길이 조건 해제'));
    // While the tab works, a second click would send the request twice.
    if (answer.canRetry) buttons.push(h('button', { class: 'btn sm', type: 'button', attrs: { disabled: busy }, on: { click: () => void store.retry(answer.id) } }, '다시 시도'));
    if (answer.status === 'done' && answer.results.length && !working) {
      buttons.push(iconButton(icon('reply', 14), '이 답에 답장', () => {
        replyTo = { answerId: answer.id, label: answer.results.length ? `${fileName(answer.results[0].sound.relativePath)}${answer.results.length > 1 ? ` 외 ${answer.results.length - 1}개` : ''}` : answer.line };
        render(store.getState());
        input.focus();
      }, 'ib reply-answer'));
    }
    if (buttons.length) view.append(h('div', { class: 'ans-actions' }, ...buttons));
    const age = flowAge(answer.id, working);
    if (age !== undefined) flowIn(view, parts, age);
    return view;
  }

  function referencePlay(reference: ChatReference): HTMLElement | null {
    const file = reference.fullHash ? outsideFiles.get(reference.fullHash) : undefined;
    const known = deps.sounds().find(({ id, fullHash }) => id === reference.soundId || (reference.fullHash && fullHash === reference.fullHash));
    const sound = known ?? (file && { id: `outside:${reference.fullHash}`, relativePath: reference.name, packId: '', duration: reference.duration, fullHash: reference.fullHash });
    if (!sound) return null;
    const on = deps.isPlaying(sound);
    return iconButton(icon(on ? 'pause' : 'play', 12), `${reference.name} ${on ? '일시 정지' : '재생'}`, () => deps.play(sound, known ? undefined : () => file!.arrayBuffer()), 'ib ref-play');
  }

  function referenceChip(reference: ChatReference, remove?: () => void): HTMLElement {
    const pack = reference.packId ? deps.packs().get(reference.packId) : undefined;
    return h('span', { class: 'refchip' },
      referencePlay(reference),
      tile(pack),
      h('span', { class: 'fname', text: reference.name }), h('span', { class: 'num', text: seconds(reference.duration) }),
      remove ? iconButton(icon('x', 10), `${reference.name} 제거`, remove, 'cond-x') : null);
  }

  /** What the panel last showed; only something new at the end moves the scroll position. */
  let drawn = '';

  function tabView(tab: ChatTab): void {
    const top = messages.scrollTop;
    const atBottom = top + messages.clientHeight >= messages.scrollHeight - 1;
    const focused = messages.contains(document.activeElement);
    const last = tab.messages.at(-1);
    const key = `${tab.id}:${tab.messages.length}:${last?.kind === 'answer' ? `${last.status}:${last.writing}` : ''}`;
    clear(messages);
    for (const message of tab.messages) {
      if (message.kind === 'user') {
        messages.append(h('div', { class: 'me' },
          message.replyTo ? h('span', { class: 'quote' }, icon('reply', 12), h('span', { text: message.replyTo.label })) : null,
          message.reference ? referenceChip(message.reference) : null,
          message.text ? h('span', { text: message.text }) : null));
      } else messages.append(answerView(message, tab.busy));
    }
    const heard = tab.messages.some((message) => message.kind === 'answer' && message.waiting) ? sentences.waiting[0] : '';
    if (spoken.textContent !== heard) spoken.textContent = heard;
    messages.classList.toggle('empty', !tab.messages.length);
    if (!tab.messages.length) messages.append(mark(32));
    // One amber ball on the screen: the newest mark holds it, unless the moving ball already does.
    if (!messages.querySelector('.fetching')) Array.from(messages.querySelectorAll('.mk')).at(-1)?.classList.add('hot');
    messages.scrollTop = key === drawn && !atBottom ? top : messages.scrollHeight;
    drawn = key;
    if (focused) messages.focus({ preventScroll: true });
  }

  /** The strip fades at an edge with more tabs beyond it, so a cut tab reads as more to come. */
  function fadeTabs(): void {
    const strip = tabsBar.querySelector('.tab-list');
    if (!strip) return;
    strip.classList.toggle('more-left', strip.scrollLeft > 1);
    strip.classList.toggle('more-right', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
  }

  function render(state: ChatState): void {
    clear(tabsBar);
    // Tabs scroll inside their own strip, so the new-tab button stays in reach however many are open.
    const tabList = h('div', { class: 'tab-list', on: { scroll: fadeTabs, wheel: (event) => { tabList.scrollLeft += event.deltaY; } } });
    for (const tab of state.tabs) {
      const active = tab.id === state.activeTabId;
      const button = h('div', { class: `tab${active ? ' on' : ''}` },
        h('button', { class: 'tab-name', type: 'button', text: tab.title, on: { click: () => store.selectTab(tab.id) } }),
        iconButton(icon('x', 12), `${tab.title} 닫기`, () => store.closeTab(tab.id)));
      tabList.append(button);
    }
    tabsBar.append(tabList, iconButton(icon('plus', 15), '새 대화', () => { store.newTab(); input.focus(); }));
    tabList.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    fadeTabs();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    clear(pinnedBar);
    if (tab) {
      if (tab.pinned.reference) pinnedBar.append(referenceChip(tab.pinned.reference, () => store.removeChip('reference')));
      const sentenceChips = tab.pinned.chips.filter((chip) => chip.kind === 'sentence');
      if (sentenceChips.length) {
        const label = requestLabel(tab, sentenceChips.map((chip) => chip.label)) ?? sentenceChips[0].label;
        pinnedBar.append(conditionChip(label, () => sentenceChips.forEach((chip) => store.removeChip(chip.id))));
      } else if (tab.busy) {
        // The request is pinned as it is sent, so the bar does not jump in when the answer arrives.
        const asked = [...tab.messages].reverse().find((message): message is ChatUserMessage => message.kind === 'user')?.text.trim();
        if (asked) pinnedBar.append(h('span', { class: 'cond', text: shortRequest(asked) }));
      }
      for (const chip of tab.pinned.chips.filter((item) => item.kind !== 'reference' && item.kind !== 'sentence')) {
        pinnedBar.append(conditionChip(chip.label, () => store.removeChip(chip.id)));
      }
      tabView(tab);
    }
    pinnedBar.hidden = !pinnedBar.childElementCount;
    clear(attach);
    attach.hidden = !replyTo;
    if (replyTo) attach.append(icon('reply', 12), h('span', { class: 'fname', text: replyTo.label }), iconButton(icon('x', 12), '답장 취소', () => { replyTo = undefined; render(store.getState()); input.focus(); }));
    clear(attachedRow);
    attachedRow.hidden = !attached;
    if (attached) {
      const pack = attached.packId ? deps.packs().get(attached.packId) : undefined;
      attachedRow.append(...[referencePlay(attached)].filter((button) => button !== null), tile(pack), h('span', { class: 'fname', text: attached.name }), h('span', { class: 'num', text: seconds(attached.duration) }),
        iconButton(icon('x', 12), '넣은 소리 빼기', () => { attached = undefined; syncSend(); render(store.getState()); input.focus(); }));
    }
    input.placeholder = attached ? 'Enter로 비슷한 소리 찾기' : replyTo?.soundId ? '이 소리에 답장' : replyTo ? '이 답에 답장' : PROMPT;
  }

  function moveCursor(row: HTMLElement | undefined): void {
    const sound = row && deps.sounds().find((item) => item.id === row.dataset.id);
    if (!sound) return;
    cursor = sound.id;
    if (deps.autoplay() && !deps.isPlaying(sound)) deps.play(sound);
    render(store.getState());
    messages.querySelector('.crow.sel')?.scrollIntoView({ block: 'nearest' });
  }

  messages.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === messages) {
      const sound = deps.sounds().find((item) => item.id === cursor);
      if (sound) { event.preventDefault(); deps.play(sound); }
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = Array.from(messages.querySelectorAll<HTMLElement>('.crow'));
    if (!rows.length) return;
    event.preventDefault();
    const current = rows.findIndex((row) => row.dataset.id === cursor);
    moveCursor(rows[Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))]);
  });
  input.addEventListener('keydown', (event) => {
    if (imeKey(event)) {
      // Enter would submit the form and empty the box under the input method, which then puts the last syllable back.
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    if (event.key === 'ArrowUp' && !input.value) {
      event.preventDefault();
      messages.focus();
      moveCursor(Array.from(messages.querySelectorAll<HTMLElement>('.crow')).at(-1));
    }
  });

  store.subscribe(render);
  render(store.getState());
  new ResizeObserver(fadeTabs).observe(tabsBar);
  return {
    store,
    refresh: () => { store.refresh(); render(store.getState()); },
    focus: () => { input.focus(); tabsBar.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); },
    results: () => Array.from(messages.querySelectorAll<HTMLElement>('.crow')).flatMap((row) => deps.sounds().find((sound) => sound.id === row.dataset.id) ?? []),
    selected: () => deps.sounds().find((sound) => sound.id === cursor),
    answerOf: (sound) => store.getState().tabs.flatMap((tab) => tab.messages)
      .filter((message): message is ChatAnswer => message.kind === 'answer' && message.results.some((item) => item.sound.id === sound.id))
      .at(-1)?.id,
  };
}
