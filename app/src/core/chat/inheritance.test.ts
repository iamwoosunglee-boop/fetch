import { describe, expect, it } from 'vitest';
import { setup, library, last, ids } from './fixtures';

describe('inheritance and replies', () => {
  it('passes previous conditions and computes relative length from previous results', async () => {
    const { store, requests } = setup({
      plan: (request) => (request.text === '더 짧게' ? { sentences: [], relative: 'shorter', message: '더 짧은 소리를 찾았어요.' } : {}),
    });
    await store.send({ text: '레이저' });
    await store.send({ text: '더 짧게' });
    expect(requests[1].previous).toMatchObject({ sentences: ['a laser'], names: [] });
    // Previous durations 1, 2, 3: median 2, so at most 1.4 seconds.
    expect(last(store).conditions.length).toEqual({ max: 2 * 70 / 100 });
    expect(last(store).conditions.sentences).toEqual(['a laser']);
  });

  it('drops the length when a request brings new sentences, and keeps it when it repeats them or brings none', async () => {
    const { store } = setup({
      plan: (request) => ({
        '5개 찾아줘': { sentences: ['a laser'], count: 5 },
        '이대로': { sentences: [] },
        '새소리': { sentences: ['a bird'] },
      }[request.text] ?? { sentences: ['a laser'], length: { max: 4 } }),
    });
    await store.send({ text: '4초 이하 레이저' });
    await store.send({ text: '5개 찾아줘' });
    expect(last(store).conditions.length).toEqual({ max: 4 });
    await store.send({ text: '이대로' });
    expect(last(store).conditions.length).toEqual({ max: 4 });
    await store.send({ text: '새소리' });
    expect(last(store).conditions.length).toBeUndefined();
    expect(store.getState().tabs[0].pinned.chips.map((chip) => chip.kind)).toEqual(['sentence']);
  });

  it('writes a length as chips and sentences read it', async () => {
    const labels: Record<string, { min?: number; max?: number }> = { '3초 이상': { min: 3 }, '0.01초 이하': { max: 0.01 }, '1-2초': { min: 1, max: 2 }, '0.25-1.5초': { min: 0.25, max: 1.5 } };
    for (const [label, length] of Object.entries(labels)) {
      const { store } = setup({ plan: () => ({ length }) });
      await store.send({ text: '레이저' });
      expect(store.getState().tabs[0].pinned.chips.find((chip) => chip.kind === 'length')?.label).toBe(label);
    }
  });

  it('goes on from the last answer that worked after a search fails', async () => {
    let failing = false;
    const { store, requests } = setup({
      plan: (request) => (failing ? { code: 'server' } : request.text === '더 짧게' ? { sentences: [], relative: 'shorter' } : {}),
    });
    await store.send({ text: '레이저' });
    const { chips } = store.getState().tabs[0].pinned;
    failing = true;
    await store.send({ text: '더 묵직한 걸로' });
    expect(store.getState().tabs[0].pinned.chips).toEqual(chips);
    failing = false;
    await store.send({ text: '더 짧게' });
    expect(requests.at(-1)?.previous).toMatchObject({ sentences: ['a laser'], message: '레이저 소리를 찾았어요.' });
    expect(last(store).conditions.length).toEqual({ max: 2 * 70 / 100 });
  });

  it('keeps a sound put in with a request that failed', async () => {
    const { store } = setup({ plan: () => ({ code: 'server' }) });
    await store.send({ text: '뿅뿅', reference: { name: 'drop.wav', duration: 1, embedding: [1, 0] } });
    expect(store.getState().tabs[0].pinned.reference?.name).toBe('drop.wav');
  });

  it('continues from a replied answer instead of the latest one', async () => {
    const { store, requests } = setup({ plan: (request) => ({ sentences: [request.text === '첫째' ? 'first' : 'second'] }) });
    await store.send({ text: '첫째' });
    const first = last(store);
    await store.send({ text: '둘째' });
    await store.send({ text: '이어서', replyTo: { answerId: first.id } });
    expect(requests[2].previous?.sentences).toEqual(['first']);
    const user = store.getState().tabs[0].messages.at(-2)!;
    expect(user).toMatchObject({ kind: 'user', replyTo: { answerId: first.id, label: first.line } });
  });

  it('makes a replied sound the reference', async () => {
    const { store, requests } = setup();
    await store.send({ text: '레이저' });
    await store.send({ text: '이런 느낌', replyTo: { answerId: last(store).id, soundId: 's1' } });
    expect(requests[1]).toMatchObject({ hasReference: true, referenceDuration: 2 });
    expect(last(store).conditions.reference).toMatchObject({ soundId: 's1', name: 'effect1.wav', packIds: ['pack0'], fullHash: 'h1' });
    expect(store.getState().tabs[0].pinned.reference?.name).toBe('effect1.wav');
    expect(ids(last(store))).not.toContain('s1');
  });

  it('removeChip drops the condition from the next request without searching', async () => {
    const { store, requests } = setup({ plan: () => ({ length: { max: 3 } }) });
    await store.send({ text: '레이저' });
    const chip = store.getState().tabs[0].pinned.chips.find((item) => item.kind === 'length')!;
    store.removeChip(chip.id);
    expect(requests).toHaveLength(1);
    store.removeChip('sentence:a laser');
    await store.send({ text: '다시' });
    expect(requests[1].previous).toBeUndefined();
  });

  it('keeps typed words in automatic conditions without a visible chip', async () => {
    const { store } = setup({ plan: () => ({ names: ['blaster'] }) });
    await store.send({ text: 'laser 중에 묵직한 소리' });
    const { chips } = store.getState().tabs[0].pinned;
    expect(chips.map((chip) => chip.kind)).toEqual(['sentence']);
    expect(chips.map((chip) => chip.label)).toEqual(['a laser']);
    expect(last(store).conditions.auto.words).toEqual(['laser']);
  });

  it('removes the automatic conditions as one group with the last sentence chip of the request', async () => {
    const { store, requests } = setup({ plan: () => ({ sentences: ['one', 'two'], names: ['blaster'] }) });
    await store.send({ text: '레이저' });
    store.removeChip('sentence:one');
    await store.send({ text: '이어서', replyTo: undefined });
    expect(requests[1].previous).toMatchObject({ sentences: ['two'], names: ['blaster'] });
    store.removeChip('sentence:one');
    store.removeChip('sentence:two');
    await store.send({ text: '다시' });
    expect(requests[2].previous).toBeUndefined();
  });

  it('keeps the automatic conditions through a length-only request', async () => {
    const { store } = setup({
      plan: (request) => (request.text === '더 짧게' ? { sentences: [], relative: 'shorter', fileWords: ['short'], typicalMaxSeconds: 1 }
        : { names: ['blaster'], fileWords: ['laser'], typicalMaxSeconds: 2 }),
    });
    await store.send({ text: '레이저 laser' });
    await store.send({ text: '더 짧게' });
    expect(last(store).conditions.auto.names).toEqual(['blaster']);
    expect(last(store).conditions.auto.fileWords).toEqual(['laser']);
    expect(last(store).conditions.auto.typicalMaxSeconds).toBe(2);
    expect(last(store).conditions.auto.words).toEqual(['laser']);
  });

  it('keeps the automatic conditions when a count request repeats the sentences', async () => {
    const { store } = setup({
      plan: (request) => (request.text === '5개 찾아줘'
        ? { sentences: ['a laser'], count: 5 }
        : { sentences: ['a laser'], fileWords: ['laser'] }),
    });
    await store.send({ text: '레이저' });
    const before = last(store).conditions.auto;
    await store.send({ text: '5개 찾아줘' });
    expect(last(store).conditions.auto.fileWords).toEqual(before.fileWords);
    expect(before.fileWords).toEqual(['laser']);
  });

  it('starts a new tab without conditions and keeps one tab after closing the last', async () => {
    const { store, requests } = setup();
    await store.send({ text: '레이저' });
    const second = store.newTab();
    expect(store.getState().activeTabId).toBe(second);
    await store.send({ text: '새 요청' });
    expect(requests[1].previous).toBeUndefined();
    expect(ids(last(store))).toEqual(['s0', 's1', 's2']);
    for (const tab of store.getState().tabs) store.closeTab(tab.id);
    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]).toMatchObject({ title: '새 대화', messages: [] });
  });

  it('titles a reference-only tab with the reference name and reports availability', async () => {
    const { store, setSounds } = setup({ sounds: [] });
    expect(store.getState().available).toBe(false);
    setSounds(library);
    store.refresh();
    expect(store.getState().available).toBe(true);
    await store.send({ text: '', reference: { name: 'drop.wav', duration: 1, embedding: [1, 0] } });
    expect(store.getState().tabs[0].title).toBe('drop.wav');
    expect(store.getState().tabs[0].title.length).toBeLessThanOrEqual(16);
  });
});
