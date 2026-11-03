import { afterEach, describe, expect, it, vi } from 'vitest';
import { sentences } from './index';
import type { ChatAnswer } from './types';
import { setup, library, answers, last, ids, allShown, facts } from './fixtures';
import { fallbackPhrase } from '../phrase';

afterEach(() => { vi.useRealTimers(); });

describe('chat answers', () => {
  it('keeps the plan explanation separately and shows three results with facts', async () => {
    const { store, requests, embedded } = setup();
    await store.send({ text: '레이저 소리' });
    const answer = last(store);
    expect(answer.status).toBe('done');
    expect(answer.line).toBe(fallbackPhrase(facts, 'search'));
    expect(answer.planMessage).toBe('레이저 소리를 찾았어요.');
    expect(ids(answer)).toEqual(['s0', 's1', 's2']);
    expect(answer.canMore).toBe(true);
    expect(requests[0]).toMatchObject({ text: '레이저 소리', hasReference: false, previous: undefined });
    expect(embedded).toEqual([['a laser']]);
    expect(store.getState().tabs[0].title).toBe('레이저 소리');
  });

  it('shows file-name matches and no line before Haiku answers', async () => {
    const { store } = setup();
    const states: ChatAnswer[] = [];
    store.subscribe((state) => {
      const answer = state.tabs[0].messages.find((message): message is ChatAnswer => message.kind === 'answer');
      if (answer) states.push(answer);
    });
    const done = store.send({ text: '레이저 laser' });
    const pending = states[0];
    expect(pending.status).toBe('pending');
    expect(pending.line).toBe('');
    expect(pending.results.every((item) => item.textMatched)).toBe(true);
    expect(pending.results.map(({ sound }) => sound.id)).toEqual(['s0', 's6', 's12']);
    expect(store.getState().tabs[0].busy).toBe(true);
    await done;
    expect(last(store).status).toBe('done');
    expect(store.getState().tabs[0].busy).toBe(false);
  });

  it.each(['레이저 laser', '레이저'])('uses the same waiting schedule for %s regardless of early matches', async (text) => {
    vi.useFakeTimers();
    let release: (value: {}) => void = () => {};
    const { store } = setup({ plan: () => new Promise((resolve) => { release = resolve; }) });
    const done = store.send({ text });
    vi.advanceTimersByTime(999);
    expect(last(store).waiting).toBeUndefined();
    for (const [ms, line] of [[1, sentences.waiting[0]], [4000, sentences.waiting[1]], [4000, sentences.waiting[2]],
      [4000, sentences.waiting[0]], [17000, sentences.waitingLong]] as const) {
      vi.advanceTimersByTime(ms);
      expect(last(store).waiting).toBe(line);
    }
    release({});
    await done;
    expect(last(store).waiting).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds the first waiting line with reduced motion', async () => {
    vi.useFakeTimers();
    let release: (value: {}) => void = () => {};
    const { store } = setup({ reducedMotion: () => true, plan: () => new Promise((resolve) => { release = resolve; }) });
    const done = store.send({ text: '레이저 소리' });
    vi.advanceTimersByTime(30_000);
    expect(last(store).status).toBe('pending');
    expect(last(store).waiting).toBe(sentences.waiting[0]);
    release({});
    await done;
    expect(last(store).waiting).toBeUndefined();
  });

  it('says nothing about a text model that arrives within a second, as one read from the cache does', async () => {
    vi.useFakeTimers();
    const { store, download } = setup();
    const done = store.send({ text: '레이저 소리' });
    download({ percent: 10 });
    vi.advanceTimersByTime(999);
    expect(last(store).line).toBe('');
    download(undefined);
    vi.advanceTimersByTime(5000);
    expect(last(store).line).toBe('');
    vi.useRealTimers();
    await done;
    expect(last(store).line).toBe(fallbackPhrase(facts, 'search'));
  });

  it('says nothing while a whole model starts up, however long that takes', async () => {
    vi.useFakeTimers();
    const { store, download } = setup();
    const done = store.send({ text: '레이저 소리' });
    download({ percent: 100 });
    vi.advanceTimersByTime(5000);
    expect(last(store).line).toBe('');
    download(undefined);
    vi.useRealTimers();
    await done;
    expect(last(store).line).toBe(fallbackPhrase(facts, 'search'));
  });

  it('marks where every more batch starts', async () => {
    const { store } = setup();
    await store.send({ text: '레이저' });
    const { id } = last(store);
    expect(last(store).cuts).toEqual([]);
    await store.more(id);
    await store.more(id);
    expect(last(store).cuts).toEqual([3, 6]);
  });

  it('says how far analysis reached on scored answers only', async () => {
    const sounds = library.map((sound, index) => (index < 20 ? sound : { ...sound, embedding: undefined }));
    let analysing = true;
    const { store } = setup({ sounds, analysing: () => analysing });
    await store.send({ text: '레이저' });
    expect(last(store).scope).toBe(sentences.analysing(20, 24));
    await store.send({ text: '"laser shot"' });
    expect(last(store).scope).toBeUndefined();
    analysing = false;
    await store.send({ text: '다른 소리' });
    expect(last(store).scope).toBeUndefined();
  });

  it('adds three unseen results on more and never repeats sounds in a tab', async () => {
    const { store } = setup();
    await store.send({ text: '레이저' });
    const first = last(store);
    await store.more(first.id);
    expect(ids(last(store))).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
    await store.send({ text: '다른 소리' });
    expect(ids(last(store))).toEqual(['s6', 's7', 's8']);
    expect(last(store).notes).toEqual([]);
    await store.send({ text: '이어서', replyTo: { answerId: first.id } });
    const shown = allShown(store);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('shows as many results as Haiku result_count, and more still adds three', async () => {
    for (const count of [1, 5, 10]) {
      const { store } = setup({ plan: () => ({ count }) });
      await store.send({ text: `${count}개 찾아줘` });
      expect(last(store).results).toHaveLength(count);
      await store.more(last(store).id);
      expect(last(store).results).toHaveLength(count + 3);
    }
  });

  it('does not pass the result count into the next request', async () => {
    const { store, requests } = setup({ plan: (request) => (request.text.includes('5개') ? { count: 5 } : {}) });
    await store.send({ text: '5개 찾아줘' });
    await store.send({ text: '더' });
    expect(last(store).results).toHaveLength(3);
    expect(requests[1].previous).not.toHaveProperty('count');
  });
});

describe('pack rule with a reference', () => {
  const reference = { soundId: 's0', name: 'laser_shot0.wav', duration: 1, embedding: [1, 0], fullHash: 'h0', packIds: ['pack0'], packId: 'pack0' };

  it('keeps score order in other packs for first and subsequent pages', async () => {
    const { store, requests } = setup();
    await store.send({ text: '', reference });
    const answer = last(store);
    expect(answer.line).toBe(fallbackPhrase({ ...facts, has_reference: true, reference_pack_avoided: true, first_file: 'laser_shot6.wav' }, 'referenceOnly'));
    expect(requests).toHaveLength(0);
    expect(ids(answer)).toEqual(['s6', 's7', 's8']);
    expect(answer.results.some(({ sound }) => sound.packId === 'pack0')).toBe(false);
    await store.more(answer.id);
    const added = last(store).results.slice(3);
    expect(added.map(({ sound }) => sound.id)).toEqual(['s9', 's10', 's11']);
  });

  it('exhausts other packs before filling from the reference pack', async () => {
    const sounds = library.filter((sound) => ['pack0', 'pack1'].includes(sound.packId));
    const { store } = setup({ sounds });
    await store.send({ text: '', reference });
    expect(ids(last(store))).toEqual(['s6', 's7', 's8']);
    expect(last(store).line).toBe(fallbackPhrase({ ...facts, has_reference: true, reference_pack_avoided: true, first_file: 'laser_shot6.wav' }, 'referenceOnly'));
  });

  it('keeps the completed sentence when more reaches the reference pack', async () => {
    const sounds = library.filter((sound) => sound.packId === 'pack0' || sound.id === 's6' || sound.id === 's12' || sound.id === 's18');
    const { store } = setup({ sounds });
    await store.send({ text: '', reference });
    const line = last(store).line;
    await store.more(last(store).id);
    expect(last(store).line).toBe(line);
  });

  it('does not claim other packs for a file from outside the library', async () => {
    const { store } = setup();
    await store.send({ text: '', reference: { name: 'drop.wav', duration: 1, embedding: [1, 0] } });
    expect(last(store).line).toBe(fallbackPhrase({ ...facts, has_reference: true }, 'referenceOnly'));
  });

  it('does not claim other packs when the library is one pack', async () => {
    const { store } = setup({ sounds: library.filter((sound) => sound.packId === 'pack0') });
    await store.send({ text: '', reference });
    expect(last(store).line).toBe(fallbackPhrase({ ...facts, has_reference: true, first_file: 'effect1.wav' }, 'referenceOnly'));
  });

  it('counts every pack of a merged sound as the reference pack', async () => {
    const sounds = library.map((sound) => (sound.id === 's1' ? { ...sound, packIds: ['pack0', 'pack1'] } : sound));
    const { store } = setup({ sounds });
    await store.send({ text: '레이저' });
    await store.send({ text: '', replyTo: { answerId: last(store).id, soundId: 's1' } });
    expect(last(store).conditions.reference?.packIds).toEqual(['pack0', 'pack1']);
    expect(last(store).results.map(({ sound }) => sound.packId)).toEqual(['pack2', 'pack2', 'pack2']);
  });

  it('uses score order for a stated count even within one pack', async () => {
    const { store } = setup({ plan: () => ({ count: 5 }) });
    await store.send({ text: '5개', reference });
    expect(last(store).results.map(({ sound }) => sound.packId)).toEqual(['pack1', 'pack1', 'pack1', 'pack1', 'pack1']);
  });
});
