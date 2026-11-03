import { describe, expect, it } from 'vitest';
import { answerLines, answerWarns, sentences } from './index';
import type { ChatAnswer } from './types';
import { setup, library, answers, last, ids, allShown, testTuning, facts } from './fixtures';
import { fallbackPhrase } from '../phrase';

describe('fixed sentences', () => {
  it('quoted search matches every word and skips Haiku', async () => {
    const { store, requests } = setup();
    await store.send({ text: '"laser shot"' });
    expect(last(store).line).toBe(sentences.quoted);
    expect(ids(last(store))).toEqual(['s0', 's6', 's12']);
    expect(requests).toHaveLength(0);
  });

  it('reports few and no new sounds', async () => {
    const { store } = setup({ sounds: library.slice(0, 4) });
    await store.send({ text: '레이저' });
    await store.send({ text: '또' });
    expect(ids(last(store))).toEqual(['s3']);
    expect(last(store).notes).toEqual([]);
    expect(last(store).line).toBe(fallbackPhrase({ ...facts, count: 1, is_short: true, more_available: false,
      length_range: '4.00초', is_refinement: true, changed: null }, 'search'));
    await store.send({ text: '또' });
    expect(last(store).results).toEqual([]);
    expect(last(store).notes).toEqual([sentences.exhausted]);
    expect(last(store).canMore).toBe(false);
  });

  it('closes an answer that showed the last sounds of the request, and hides more', async () => {
    const { store } = setup({ sounds: library.slice(0, 3) });
    await store.send({ text: '레이저' });
    expect(last(store)).toMatchObject({ canMore: false, closing: sentences.exhausted });
    expect(answerLines(last(store))).not.toContain(sentences.exhausted);
  });

  it('closes after more shows the last sounds, and not before', async () => {
    const { store } = setup({ sounds: library.slice(0, 5) });
    await store.send({ text: '레이저' });
    expect(last(store).closing).toBeUndefined();
    await store.more(last(store).id);
    expect(last(store)).toMatchObject({ canMore: false, closing: sentences.exhausted });
  });

  it('says so when the reference is all there is', async () => {
    const reference = { name: 'a.wav', duration: 1, embedding: [1, 0], fullHash: library[0].fullHash };
    const { store } = setup({ sounds: library.slice(0, 1) });
    await store.send({ text: '', reference });
    expect(last(store).results).toEqual([]);
    expect(last(store).notes).toEqual([sentences.noCandidate]);
  });

  it('reports no results', async () => {
    const { store } = setup({ sounds: [] });
    await store.send({ text: '레이저' });
    expect(last(store).notes).toEqual([sentences.noResults]);
  });

  it('says a repeated quoted search has nothing new, not that the name does not exist', async () => {
    const { store } = setup();
    await store.send({ text: '"laser shot"' });
    await store.more(last(store).id);
    await store.send({ text: '"laser shot"' });
    expect(last(store).notes).toEqual([sentences.exhausted]);
    await store.send({ text: '"no such name"' });
    expect(last(store).notes).toEqual([sentences.quotedEmpty]);
  });

  describe('with nothing analysed yet', () => {
    const unanalysed = library.map((sound) => ({ ...sound, duration: 0, embedding: undefined }));

    it('shows only file-name matches, with no claim about closeness or how far it reached', async () => {
      const { store } = setup({ sounds: unanalysed, analysing: () => true, plan: () => ({ fileWords: ['laser'] }) });
      await store.send({ text: '레이저' });
      expect(ids(last(store))).toEqual(['s0', 's6', 's12']);
      expect(last(store).scope).toBeUndefined();
      await store.more(last(store).id);
      expect(ids(last(store))).toEqual(['s0', 's6', 's12', 's18']);
    });

    it('says so in one line and asks for no sentence when no name matches', async () => {
      let phrases = 0;
      const { store } = setup({ sounds: unanalysed, analysing: () => true, plan: () => ({ fileWords: ['cough'], length: { min: 3 } }), phrase: async () => { phrases++; return ''; } });
      await store.send({ text: '기침 소리' });
      expect(answerLines(last(store))).toEqual([sentences.noneAnalysed]);
      expect(last(store).results).toEqual([]);
      expect(phrases).toBe(0);
    });
  });

  it('stays quiet about length when the length condition still fills the answer', async () => {
    const { store } = setup({ plan: () => ({ length: { max: 3 } }) });
    await store.send({ text: '3초 안쪽 레이저' });
    const answer = last(store);
    expect(answer.results).toHaveLength(3);
    expect(answer.canRelaxLength).toBe(false);
    expect(answer.notes).not.toContain(sentences.lengthRemoved);
  });

  it('reports length removals and relaxes them as a new answer', async () => {
    const { store } = setup({ plan: () => ({ length: { max: 0.1 } }) });
    await store.send({ text: '아주 짧은 레이저' });
    const answer = last(store);
    expect(answer.results).toEqual([]);
    expect(answer.canRelaxLength).toBe(true);
    expect(answer.notes).toEqual([sentences.lengthRemoved, sentences.noResults]);
    await store.relaxLength(answer.id);
    const relaxed = last(store);
    expect(relaxed.id).not.toBe(answer.id);
    expect(relaxed.conditions.length).toBeUndefined();
    expect(ids(relaxed)).toEqual(['s0', 's1', 's2']);
    expect(store.getState().tabs[0].pinned.chips.some((chip) => chip.kind === 'length')).toBe(false);
  });

  it('refuses a reply to a sound that is not analysed yet', async () => {
    const sounds = [{ ...library[0], embedding: undefined }, ...library.slice(1)];
    const { store, requests } = setup({ sounds });
    await store.send({ text: '레이저' });
    await store.send({ text: '', replyTo: { answerId: last(store).id, soundId: 's0' } });
    expect(last(store)).toMatchObject({ status: 'failed', error: 'notAnalyzed', line: sentences.notAnalyzed });
    expect(requests).toHaveLength(1);
  });

  it.each(['timeout', 'format', 'server', 'offline', 'limit', 'model', 'unknown'])('maps %s to AI unavailable with file-name results', async (code) => {
    const { store, embedded } = setup({ plan: () => ({ code }) });
    await store.send({ text: '레이저 laser' });
    const answer = last(store);
    expect(answer).toMatchObject({ status: 'failed', line: sentences.partial, error: code === 'unknown' ? 'server' : code });
    expect(answer.results[0].textMatched).toBe(true);
    expect(embedded).toEqual([]);
  });

  it('keeps only file-name matches when Haiku fails', async () => {
    const { store } = setup({ plan: () => ({ code: 'offline' }) });
    await store.send({ text: '레이저 laser' });
    await store.more(last(store).id);
    expect(ids(last(store))).toEqual(['s0', 's6', 's12', 's18']);
    expect(last(store).canMore).toBe(false);
  });

  it('shows no unrelated sounds when Haiku fails on a Korean-only request', async () => {
    const { store, embedded } = setup({ plan: () => ({ code: 'offline' }) });
    await store.send({ text: '금속 부딪히는 소리' });
    expect(last(store)).toMatchObject({ status: 'failed', line: sentences.unavailable, results: [] });
    expect(answerLines(last(store))).toEqual([sentences.unavailable]);
    expect(embedded).toEqual([]);
  });

  it('says nothing was found, not that length cut sounds, when Haiku fails and no file name matches', async () => {
    let calls = 0;
    const { store } = setup({ plan: () => (calls++ === 0 ? { length: { max: 2 } } : { code: 'offline' }) });
    await store.send({ text: '짧은 레이저' });
    await store.send({ text: '폭발하는 소리' });
    expect(last(store)).toMatchObject({ status: 'failed', results: [], canRelaxLength: false });
    expect(last(store).notes).toEqual([]);
  });

  it.each(['timeout', 'format', 'server', 'offline', 'limit'])('with a reference, %s gives the calm sentence, no warning, and the reference results', async (code) => {
    const { store } = setup({ plan: () => ({ code }) });
    await store.send({ text: '뿅뿅', reference: { name: 'drop.wav', duration: 1, embedding: [1, 0] } });
    const answer = last(store);
    expect(answer).toMatchObject({ status: 'failed', line: sentences.referenceUnread, error: code });
    expect(answerWarns(answer)).toBe(false);
    expect(answer.results).toHaveLength(3);
  });

  it('keeps the daily limit sentence without warning when reference results exist', async () => {
    const { store } = setup({ plan: () => ({ code: 'dailyLimit' }) });
    await store.send({ text: '뿅뿅', reference: { name: 'drop.wav', duration: 1, embedding: [1, 0] } });
    expect(last(store).line).toBe(sentences.dailyLimit);
    expect(answerWarns(last(store))).toBe(false);
    expect(last(store).canRetry).toBe(false);
  });

  it('keeps the warning without a reference', async () => {
    const { store } = setup({ plan: () => ({ code: 'timeout' }) });
    await store.send({ text: '레이저' });
    expect(answerWarns(last(store))).toBe(true);
  });

  it('a text model failure with a reference also falls back calmly', async () => {
    const { store } = setup({ embed: () => { throw new Error('no model'); } });
    await store.send({ text: '뿅뿅', reference: { name: 'drop.wav', duration: 1, embedding: [1, 0] } });
    expect(last(store)).toMatchObject({ status: 'failed', line: sentences.referenceUnread, error: 'model' });
    expect(answerWarns(last(store))).toBe(false);
  });

  it('maps the daily limit to its own sentence', async () => {
    const { store } = setup({ plan: () => ({ code: 'dailyLimit' }) });
    await store.send({ text: '레이저' });
    expect(last(store)).toMatchObject({ line: sentences.dailyLimit, error: 'dailyLimit' });
  });

  it('sends only English requests to CLAP when Haiku fails', async () => {
    const { store, embedded } = setup({ plan: () => ({ code: 'offline' }) });
    await store.send({ text: 'laser blast' });
    expect(embedded).toEqual([['laser blast']]);
    expect(ids(last(store))[0]).toBe('s0');
  });

  it('reports a text model failure as AI unavailable', async () => {
    const { store } = setup({ embed: () => { throw new Error('no model'); } });
    await store.send({ text: '레이저' });
    expect(last(store)).toMatchObject({ status: 'failed', error: 'model', line: sentences.unavailable });
  });
});

describe('how sure an answer is', () => {
  // Every cosine against [1, 0] is 0.6.
  const weak = library.slice(0, 6).map((sound, index) => ({ ...sound, relativePath: `pack0/effect${index}.wav`, embedding: [3, 4] }));
  const strong = [...library.slice(0, 3).map((sound) => ({ ...sound, embedding: [1, 0] })), ...weak.slice(3)];
  const outside = { name: 'drop.wav', duration: 1, embedding: [1, 0] };
  const haiku = fallbackPhrase(facts, 'search');
  const weakFacts = { ...facts, first_file: 'effect0.wav', is_low_score: true };
  const uncertain = fallbackPhrase(weakFacts, 'search');
  const cuts = (thresholds: Partial<typeof testTuning.thresholds>) => ({ ...testTuning, thresholds: { text: null, reference: null, both: null, ...thresholds } });

  it.each([[0.7, uncertain], [0.6, uncertain], [0.59, haiku], [null, uncertain]])('with a text cut of %s the answer opens with %s', async (text, line) => {
    const { store } = setup({ sounds: weak, tuning: cuts({ text }) });
    await store.send({ text: '애매한 소리' });
    expect(answerLines(last(store))).toEqual([line]);
    expect(last(store).results).toHaveLength(3);
    expect(last(store).canMore).toBe(true);
  });

  it.each([[0.7, true], [0.6, true], [0.59, false], [null, true]] as const)('with a mixed cut of %s the answer low decision is %s', async (both, low) => {
    const { store } = setup({ sounds: weak, tuning: cuts({ both }) });
    await store.send({ text: '애매한 소리', reference: outside });
    expect(answerLines(last(store))).toEqual([fallbackPhrase({ ...weakFacts, has_reference: true, is_low_score: low }, 'search')]);
  });

  it('keeps the reference sentences with a null reference cut and uses a set one', async () => {
    const off = setup({ sounds: weak, tuning: cuts({}) });
    await off.store.send({ text: '', reference: outside });
    expect(answerLines(last(off.store))).toEqual([fallbackPhrase({ ...weakFacts, is_low_score: false, has_reference: true }, 'referenceOnly')]);
    const set = setup({ sounds: weak, tuning: cuts({ reference: 0.6 }) });
    await set.store.send({ text: '', reference: outside });
    expect(answerLines(last(set.store))).toEqual([uncertain]);
  });

  it('counts shown sounds, so a follow-up is not weak because the best ones were shown', async () => {
    const { store } = setup({ sounds: strong, tuning: cuts({ text: 0.7 }) });
    await store.send({ text: '레이저' });
    await store.send({ text: '다른 소리' });
    expect(ids(last(store))).toEqual(['s3', 's4', 's5']);
    expect(answerLines(last(store))).toEqual([fallbackPhrase({ ...facts, length_range: '4.00-6.00초', more_available: false, is_refinement: true, changed: null }, 'search')]);
  });

  it('keeps the decision of the answer through more', async () => {
    const unsure = setup({ sounds: weak, tuning: cuts({ text: 0.7 }) });
    await unsure.store.send({ text: '레이저' });
    await unsure.store.more(last(unsure.store).id);
    expect(last(unsure.store).results).toHaveLength(6);
    expect(answerLines(last(unsure.store))).toEqual([uncertain]);
    const clear = setup({ sounds: strong, tuning: cuts({ text: 0.7 }) });
    await clear.store.send({ text: '레이저' });
    await clear.store.more(last(clear.store).id);
    expect(last(clear.store).results).toHaveLength(6);
    expect(answerLines(last(clear.store))).toEqual([haiku]);
  });

  it.each([
    ['a file name leading the answer', { text: '레이저', plan: { names: ['effect0'] } }, haiku],
    ['a quoted search', { text: '"effect0"', plan: {} }, sentences.quoted],
    ['a failed plan', { text: 'laser blast', plan: { code: 'offline' } }, sentences.partial],
  ])('makes no decision for %s', async (_case, { text, plan }, line) => {
    const { store } = setup({ sounds: weak, tuning: cuts({ text: 0.7 }), plan: () => plan });
    await store.send({ text });
    if (_case === 'a file name leading the answer') {
      expect(last(store).line).toBe(fallbackPhrase(facts, 'search'));
    } else expect(answerLines(last(store))).toContain(line);
    expect(last(store).notes).toEqual([]);
  });

  it('makes no decision when the text model fails, nor when a failed answer is relaxed', async () => {
    let calls = 0;
    const { store } = setup({
      sounds: weak, tuning: cuts({ text: 0.7 }),
      plan: () => (calls++ === 0 ? { length: { max: 0.1 } } : { code: 'offline' }),
    });
    await store.send({ text: 'laser' });
    await store.send({ text: 'laser blast' });
    const failed = last(store);
    expect(failed).toMatchObject({ status: 'failed', canRelaxLength: true });
    await store.relaxLength(failed.id);
    expect(answerLines(last(store))).toContain(sentences.partial);
    expect(last(store).notes).toEqual([]);
    const model = setup({ sounds: weak, tuning: cuts({ text: 0.7 }), embed: () => { throw new Error('no model'); } });
    await model.store.send({ text: '레이저' });
    expect(last(model.store).notes).toEqual([]);
  });

  it('keeps the analysing sentence beside the decision', async () => {
    const { store } = setup({ sounds: weak, tuning: cuts({ text: 0.7 }), analysing: () => true });
    await store.send({ text: '레이저' });
    expect(answerLines(last(store))).toEqual([uncertain, sentences.analysingLow(6, 6)]);
  });

  it('quotes the line the person saw when replying to an answer', async () => {
    const { store } = setup({ sounds: weak, tuning: cuts({ text: 0.7 }) });
    await store.send({ text: '레이저' });
    await store.send({ text: '이어서', replyTo: { answerId: last(store).id } });
    expect(store.getState().tabs[0].messages.at(-2)).toMatchObject({ replyTo: { label: uncertain } });
  });
});

