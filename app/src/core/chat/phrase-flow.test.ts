import { describe, expect, it, vi } from 'vitest';
import { answerLines, answerWarns, sentences } from './index';
import { answers, setup, facts, last, library } from './fixtures';
import { fallbackPhrase, type PhraseFacts } from '../phrase';

describe('final answer sentence lifecycle', () => {
  it('gives up on a sentence after 3 seconds and uses the app sentence', async () => {
    vi.useFakeTimers();
    try {
      const { store } = setup({ phrase: () => new Promise(() => {}) });
      const done = store.send({ text: '레이저' });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(last(store)).toMatchObject({ writing: true, line: '' });
      await vi.advanceTimersByTimeAsync(2);
      await done;
      expect(last(store).writing).toBe(false);
      expect(last(store).line).not.toBe('');
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes results before writing, keeps the plan context, and never rewrites on more', async () => {
    let release: (value: string) => void = () => {};
    let entered: () => void = () => {};
    const called = new Promise<void>((resolve) => { entered = resolve; });
    const sent: PhraseFacts[] = [];
    const { store, requests, logs } = setup({ phrase: (value) => {
      sent.push(value);
      entered();
      return new Promise((resolve) => { release = resolve; });
    } });
    const done = store.send({ text: '레이저' });
    await called;
    expect(last(store)).toMatchObject({ status: 'done', writing: true, line: '' });
    expect(last(store).waiting).toBeUndefined();
    expect(last(store).results).toHaveLength(3);
    release(fallbackPhrase({ ...facts, packs: [] }, 'search'));
    await done;
    const first = last(store);
    expect(first.writing).toBe(false);
    expect(sent).toEqual([facts]);
    await store.more(first.id);
    expect(last(store).line).toBe(first.line);
    expect(sent).toHaveLength(1);
    const next = store.send({ text: '더 짧게', replyTo: { answerId: first.id } });
    // The request is sent synchronously, before the async plan resolves.
    expect(requests[1]?.previous?.message).toBe(first.planMessage);
    store.dispose();
    release(fallbackPhrase(facts, 'search'));
    await next;
    expect(logs[0]).toMatchObject({ event: 'search', answerId: first.id, plan_failure: null, phrase_failure: null });
  });

  it.each(['invalid', 'error'] as const)('uses the app sentence after %s without retry or warning', async (mode) => {
    let calls = 0;
    const { store, logs } = setup({ phrase: async () => {
      calls++;
      if (mode === 'error') throw new Error('TIMEOUT');
      return '999개를 가져왔어요.';
    } });
    await store.send({ text: '레이저' });
    expect(last(store).line).toBe(fallbackPhrase(facts, 'search'));
    expect(answerWarns(last(store))).toBe(false);
    expect(calls).toBe(1);
    expect(logs[0]?.phrase_failure).toBe(mode === 'error' ? 'TIMEOUT' : 'validation');
  });

  it('drops a late phrase when its tab is closed', async () => {
    let release: (value: string) => void = () => {};
    let entered: () => void = () => {};
    const called = new Promise<void>((resolve) => { entered = resolve; });
    const { store, logs } = setup({ phrase: () => {
      entered();
      return new Promise((resolve) => { release = resolve; });
    } });
    const done = store.send({ text: '레이저' });
    await called;
    store.closeTab(store.getState().activeTabId);
    release(fallbackPhrase(facts, 'search'));
    await done;
    expect(store.getState().tabs[0]?.messages).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('does not call phrase for quoted, empty, reference-only, failed, overlong or relaxed answers', async () => {
    let calls = 0;
    const { store } = setup({
      phrase: async () => { calls++; return fallbackPhrase(facts, 'search'); },
      plan: (request) => request.text === 'fail' ? { code: 'server' } : { length: { max: 0.1 } },
    });
    await store.send({ text: '"missing"' });
    expect(answerLines(last(store))).toEqual([sentences.quotedEmpty]);
    await store.send({ text: '', reference: { name: 'drop.wav', duration: 1, embedding: [1, 0] } });
    await store.send({ text: 'fail' });
    await store.send({ text: 'x'.repeat(201) });
    expect(last(store).line).toBe(sentences.tooLong);
    await store.send({ text: 'short' });
    await store.relaxLength(last(store).id);
    expect(calls).toBe(0);
  });

  it('retries the same request as a new answer in the original tab', async () => {
    let calls = 0;
    const { store, requests } = setup({ plan: () => calls++ === 0 ? { sentences: ['a laser'] } : { code: 'server' } });
    const originalTab = store.getState().activeTabId;
    await store.send({ text: '레이저' });
    await store.send({ text: '더 짧게' });
    const first = last(store);
    store.newTab();
    await store.retry(first.id);
    expect(store.getState().activeTabId).toBe(originalTab);
    expect(last(store).id).not.toBe(first.id);
    expect(requests.map(({ text }) => text)).toEqual(['레이저', '더 짧게', '더 짧게']);
    expect(requests[2]).toEqual(requests[1]);
    expect(answerLines(last(store))).toEqual([sentences.unavailable]);
    expect(answers(store).find(({ id }) => id === first.id)?.canRetry).toBe(false);
    await store.retry(first.id);
    expect(requests).toHaveLength(3);
  });

  it.each([['missing', true], ['laser', false], ['', false]] as const)('checks %s against all names including unanalyzed files', async (word, missing) => {
    const sounds = library.map((sound, index) => ({ ...sound, embedding: index === 0 ? undefined : [0, 1] }));
    const { store } = setup({ sounds, plan: () => ({ fileWords: word ? [word] : [] }) });
    await store.send({ text: '레이저' });
    expect(last(store).reason).toBe(missing ? sentences.missingName('레이저') : undefined);
    expect(answerLines(last(store))[0]).toBe(last(store).reason ?? last(store).line);
  });
});
