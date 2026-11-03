// Chat search logic: tabs, answers and the conditions each answer leaves behind (PRD v4 7.3).
// allow: SIZE_OK - One tab state machine owns pending replies, cancellation and shown-result sets in a shared closure.
import { nonHangulWords, rankResults, relativeLength, tokenize, type LengthCondition, type RankOptions, type RankedSound, type SearchSound, type Vector } from '../search';
import type { SearchPlan } from '../../platform/types';
import { checkPhrase, fallbackPhrase, type PhraseFacts, type PhraseKind } from '../phrase';
import type {
  AutoConditions, ChatAnswer, ChatChip, ChatConditions, ChatErrorCode, ChatMessage, ChatReference, ChatState, ChatStore,
  ChatStoreOptions, ChatTab, ChatUserMessage,
} from './types';
import { sentences } from './sentences';

export type * from './types';
export { sentences } from './sentences';

const batch = 3;
/** The longest text a person can send (PRD 7.7). */
export const maxRequestLength = 200;
const newTitle = '새 대화';
const relayCodes: readonly ChatErrorCode[] = ['offline', 'timeout', 'format', 'server', 'limit', 'dailyLimit', 'model'];

interface Tab {
  id: string;
  title: string;
  messages: ChatMessage[];
  /** Conditions the next request inherits; removeChip edits them. */
  base: ChatConditions;
  /** Ids and full hashes of every final result shown in the tab. */
  shown: Set<string>;
  pending: number;
}

/** What "더 보기" and "길이 조건 해제" need to rank an answer again without Haiku or the text model. */
interface Ranking {
  tab: Tab;
  embeddings: Vector[];
  quoted?: string;
  count: number;
  request?: string;
  plan?: SearchPlan;
  refinement?: boolean;
  changed?: PhraseFacts['changed'];
  top?: RankedSound[];
  analysis?: { total: number; analysed: number };
}

interface RetryRequest {
  readonly input: Parameters<ChatStore['send']>[0];
  readonly base: ChatConditions;
  readonly continued?: ChatAnswer;
}

function failureCode(error: unknown): ChatErrorCode {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return (relayCodes as readonly string[]).includes(code) ? code as ChatErrorCode : 'server';
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * What Haiku picked beyond its sentences (PRD 7.3 자동 조건). The fields travel as one group per request:
 * a new automatic condition is one more line here, and inheriting and removing need no change.
 */
export const autoConditions = (plan?: SearchPlan, words: string[] = []) => ({
  words,
  names: plan?.names ?? [], fileWords: plan?.fileWords ?? [], typicalMaxSeconds: plan?.typicalMaxSeconds ?? null,
});

const phraseWaitMs = 3_000;

const noAuto = (auto: AutoConditions) => Object.values(auto).flat().every((value) => value === null || value === undefined);

/** A library sound as the reference; every pack holding its content counts (PRD 7.3). */
export function referenceFor(sound: SearchSound): ChatReference {
  return {
    soundId: sound.id, name: fileName(sound.relativePath), duration: sound.duration, embedding: sound.embedding ?? [],
    fullHash: sound.fullHash, packIds: sound.packIds ?? [sound.packId], packId: sound.packId,
  };
}

function empty(): ChatConditions {
  return { sentences: [], auto: autoConditions() };
}

function rankOptions(conditions: ChatConditions, embeddings: readonly Vector[], quoted?: string): RankOptions {
  const { reference } = conditions;
  return {
    query: quoted ?? conditions.auto.words.join(' '),
    textMode: 'any',
    names: conditions.auto.names,
    fileWords: conditions.auto.fileWords,
    typicalMaxSeconds: conditions.auto.typicalMaxSeconds,
    textEmbeddings: embeddings,
    reference: reference && { embedding: reference.embedding, fullHash: reference.fullHash, packIds: reference.packIds },
    length: conditions.length,
    // With no sentence and no reference, every score is 0, so only file-name matches mean anything.
    matchedOnly: embeddings.length === 0 && !reference,
  };
}

/** A length condition on chips and in sentences: a range reads 1-2초, and a small value keeps its decimals. */
function lengthLabel({ min, max }: LengthCondition): string {
  const seconds = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  if (min !== undefined && max !== undefined) return `${seconds(min)}-${seconds(max)}초`;
  return min !== undefined ? `${seconds(min)}초 이상` : `${seconds(max ?? 0)}초 이하`;
}

function seen(shown: ReadonlySet<string>, sound: SearchSound): boolean {
  return shown.has(sound.id) || (sound.fullHash !== undefined && shown.has(sound.fullHash));
}

/** Only a failed, empty answer warns; unfinished analysis is not a search failure. */
export const answerWarns = (answer: ChatAnswer) =>
  answer.status === 'failed' && answer.results.length === 0 && answer.error !== 'notAnalyzed';

/** Reason, final sentence, notices and analysis scope, in display order. */
export function answerLines(answer: ChatAnswer): string[] {
  return [answer.reason ?? '', answer.line, ...answer.notes, answer.scope ?? ''].filter(Boolean);
}

export function createChatStore(options: ChatStoreOptions): ChatStore {
  const { platform } = options;
  const rank = (sounds: readonly SearchSound[], ranking: RankOptions) => rankResults(sounds, { ...ranking, tuning: options.tuning });
  let counter = 0;
  const newId = options.newId ?? (() => `chat-${++counter}`);
  const listeners = new Set<(state: ChatState) => void>();
  const rankings = new Map<string, Ranking>();
  const abort = new AbortController();
  const waitingTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  const requests = new Map<string, RetryRequest>();
  const phraseControllers = new Map<string, AbortController>();
  let available = false;
  let disposed = false;

  const makeTab = (): Tab => ({ id: newId(), title: newTitle, messages: [], base: empty(), shown: new Set(), pending: 0 });
  let tabs: Tab[] = [makeTab()];
  let activeTabId = tabs[0].id;

  const chips = (base: ChatConditions): ChatChip[] => [
    ...(base.reference ? [{ id: 'reference', kind: 'reference' as const, label: base.reference.name }] : []),
    ...base.sentences.map((label) => ({ id: `sentence:${label}`, kind: 'sentence' as const, label })),
    ...(base.length ? [{ id: 'length', kind: 'length' as const, label: lengthLabel(base.length) }] : []),
  ];

  const snapshot = (tab: Tab): ChatTab => ({
    id: tab.id, title: tab.title, busy: tab.pending > 0,
    messages: tab.messages.map((message) => message.kind === 'answer'
      ? { ...message, results: [...message.results], notes: [...message.notes], cuts: [...message.cuts] } : { ...message }),
    pinned: { reference: tab.base.reference, chips: chips(tab.base) },
  });

  const getState = (): ChatState => ({ tabs: tabs.map(snapshot), activeTabId, available });

  const emit = () => {
    if (disposed) return;
    const state = getState();
    for (const listener of listeners) listener(state);
  };

  const refreshAvailable = () => { available = options.sounds().length > 0; };
  refreshAvailable();
  const stopWaiting = (answer: ChatAnswer) => {
    for (const timer of waitingTimers.get(answer.id) ?? []) clearTimeout(timer);
    waitingTimers.delete(answer.id);
    delete answer.waiting;
  };

  const findAnswer = (answerId: string): { tab: Tab; answer: ChatAnswer } | undefined => {
    for (const tab of tabs) {
      const answer = tab.messages.find((message): message is ChatAnswer => message.kind === 'answer' && message.id === answerId);
      if (answer) return { tab, answer };
    }
    return undefined;
  };

  /** The answer the next request goes on from: a failed one found nothing to go on from. */
  const lastAnswer = (tab: Tab): ChatAnswer | undefined =>
    [...tab.messages].reverse().find((message): message is ChatAnswer => message.kind === 'answer' && message.status === 'done');

  /** With nothing analysed no score means anything, so only file names can answer. */
  const searchOptions = (conditions: ChatConditions, ranking: Ranking): RankOptions => {
    const base = rankOptions(conditions, ranking.embeddings, ranking.quoted);
    return options.sounds().some(({ embedding }) => embedding) ? base
      : { ...base, matchedOnly: true, names: [...conditions.auto.names, ...conditions.auto.fileWords] };
  };

  /** Ranks the final results, records them as shown and adds the fixed sentences for what the search found. */
  const finish = (answer: ChatAnswer, ranking: Ranking, status: 'done' | 'failed'): PhraseFacts => {
    const { tab, count } = ranking;
    const base = searchOptions(answer.conditions, ranking);
    const sounds = options.sounds();
    const analysed = sounds.filter(({ embedding }) => embedding).length;
    const result = rank(sounds, { ...base, exclude: tab.shown, count });
    ranking.top = platform.log ? rank(sounds, { ...base, exclude: tab.shown, count: 10 }).results : [];
    ranking.analysis = { total: sounds.length, analysed };
    const excluded = tab.shown.size > 0
      && rank(sounds, { ...base, count }).results.some(({ sound }) => seen(tab.shown, sound));
    for (const { sound } of result.results) {
      tab.shown.add(sound.id);
      if (sound.fullHash) tab.shown.add(sound.fullHash);
    }
    answer.results = result.results;
    answer.canMore = result.hasMore;
    // Only a length condition that left the answer short is worth a sentence and a relax button.
    answer.canRelaxLength = analysed > 0 && result.lengthRemoved > 0 && answer.conditions.length !== undefined && result.results.length < count;
    answer.status = status;
    stopWaiting(answer);
    const notes: string[] = [];
    if (answer.canRelaxLength) notes.push(sentences.lengthRemoved);
    if (result.results.length === 0 && status === 'done') {
      notes.push(excluded ? sentences.exhausted
        : ranking.quoted ? sentences.quotedEmpty
          : sounds.length > 0 && !analysed ? sentences.noneAnalysed
            : answer.conditions.reference ? sentences.noCandidate : sentences.noResults);
    }
    if (status === 'failed') {
      answer.line = answer.error === 'dailyLimit' ? sentences.dailyLimit : result.results.length === 0
        ? sentences.unavailable : answer.conditions.reference ? sentences.referenceUnread : sentences.partial;
      answer.canRetry = answer.error !== 'dailyLimit';
      notes.length = 0;
    }
    answer.notes = notes;
    answer.closing = status === 'done' && !result.hasMore && result.results.length >= count ? sentences.exhausted : undefined;
    // Only analysed sounds have scores, so a search during analysis says how far it reached (PRD 7.3).
    const scored = ranking.embeddings.length > 0 || answer.conditions.reference !== undefined;
    answer.scope = scored && analysed > 0 && options.analysing?.()
      ? (result.uncertain ? sentences.analysingLow : sentences.analysing)(analysed, sounds.length) : undefined;
    const fileWords = ranking.plan?.fileWords ?? [];
    const present = !fileWords.length || sounds.some((sound) => {
      const words = new Set(tokenize(fileName(sound.relativePath)));
      return fileWords.some((word) => tokenize(word).some((token) => words.has(token)));
    });
    answer.reason = status === 'done' && result.uncertain && !options.analysing?.() && !present
      ? sentences.missingName(ranking.request ?? '') : undefined;
    rankings.set(answer.id, ranking);
    // A failed search takes back nothing the tab had; only the sound put in with it stays.
    tab.base = status === 'done' ? answer.conditions : { ...tab.base, reference: answer.conditions.reference };
    const packCounts = new Map<string, number>();
    for (const { sound } of result.results) {
      const name = options.packName?.(sound) ?? sound.packName ?? sound.packId.split(/[\\/]/).filter(Boolean).at(-1) ?? sound.packId;
      packCounts.set(name, (packCounts.get(name) ?? 0) + 1);
    }
    const packs = [...packCounts].map(([name, count]) => ({ name, count }));
    const durations = result.results.map(({ sound }) => sound.duration);
    const min = Math.min(...durations).toFixed(2);
    const max = Math.max(...durations).toFixed(2);
    const first = result.results[0]?.sound;
    const file = first ? fileName(first.relativePath) : null;
    const referencePacks = new Set(answer.conditions.reference?.packIds);
    return {
      count: result.results.length, requested_count: count, packs,
      main_pack: packs.length > 1 ? packs.find(({ count }) => count > result.results.length / 2)?.name ?? null : null,
      length_range: answer.conditions.length || !durations.length || durations.some((n) => n <= 0)
        ? null : min === max ? `${min}초` : `${min}-${max}초`,
      length_condition: answer.conditions.length ? lengthLabel(answer.conditions.length) : null,
      first_file: file && [...file].length <= 80 ? file : null,
      is_low_score: result.uncertain, has_reference: Boolean(answer.conditions.reference),
      reference_pack_avoided: referencePacks.size > 0 && result.results.every(({ sound }) =>
        !(sound.packIds ?? [sound.packId]).some((pack) => referencePacks.has(pack))),
      is_refinement: ranking.refinement ?? false, changed: ranking.changed ?? null,
      more_available: result.hasMore, is_short: result.results.length < count,
      already_shown_excluded: excluded, removed_by_length: result.lengthRemoved,
    };
  };

  const record = (answer: ChatAnswer, details: {
    readonly facts?: PhraseFacts; readonly planMs?: number; readonly phraseMs?: number;
    readonly phraseFailure?: string | null; readonly rejected?: string | null;
  }) => {
    const ranking = rankings.get(answer.id);
    const { reference, ...conditions } = answer.conditions;
    platform.log?.({
      event: 'search', answerId: answer.id, timestamp: new Date().toISOString(),
      request: requests.get(answer.id)?.input.text ?? ranking?.request ?? '',
      plan: ranking?.plan ?? null, conditions: { ...conditions,
        reference: reference ? { soundId: reference.soundId, name: reference.name, duration: reference.duration } : null },
      results: ranking?.top?.map(({ sound, score, rawScore }) => ({
        path: sound.root ? `${sound.root}/${sound.relativePath}` : sound.relativePath, score, rawScore,
      })) ?? [],
      is_low_score: details.facts?.is_low_score ?? false,
      analysis: ranking?.analysis ?? { total: options.sounds().length, analysed: options.sounds().filter(({ embedding }) => embedding).length },
      plan_ms: details.planMs ?? 0, plan_failure: answer.error === 'model' ? null : answer.error ?? null,
      search_failure: answer.error ?? null, phrase_ms: details.phraseMs ?? 0,
      phrase_failure: details.phraseFailure ?? null, rejected_phrase: details.rejected ?? null,
    });
  };

  const settle = async (answer: ChatAnswer, facts: PhraseFacts, context: {
    readonly kind: PhraseKind; readonly call: boolean; readonly planMs?: number;
  }) => {
    const { kind, call, planMs = 0 } = context;
    let phraseMs = 0;
    let phraseFailure: string | null = null;
    let rejected: string | null = null;
    if (answer.status === 'done' && answer.results.length && !rankings.get(answer.id)?.quoted) {
      const fallback = fallbackPhrase(facts, kind);
      answer.line = fallback;
      if (call && platform.phrase) {
        answer.writing = true;
        answer.line = '';
        emit();
        const controller = new AbortController();
        phraseControllers.set(answer.id, controller);
        const began = performance.now();
        let slow: ReturnType<typeof setTimeout> | undefined;
        try {
          // The results wait for the sentence, so a slow sentence gives way to the app's own.
          const message = await Promise.race([platform.phrase(facts, controller.signal), new Promise<never>((_, reject) => {
            slow = setTimeout(() => reject(new Error('slow')), phraseWaitMs);
          })]);
          if (disposed || controller.signal.aborted || !findAnswer(answer.id)) return;
          if (checkPhrase(message, facts)) answer.line = message;
          else { rejected = message; phraseFailure = 'validation'; answer.line = fallback; }
        } catch (error) {
          if (disposed || controller.signal.aborted || !findAnswer(answer.id)) return;
          phraseFailure = error instanceof Error ? error.message : String(error);
          answer.line = fallback;
        } finally {
          clearTimeout(slow);
          phraseMs = Math.round(performance.now() - began);
          phraseControllers.delete(answer.id);
        }
      }
    }
    answer.writing = false;
    record(answer, { facts, planMs, phraseMs, phraseFailure, rejected });
  };

  const start = (tab: Tab, conditions: ChatConditions, line = ''): ChatAnswer => {
    const answer: ChatAnswer = {
      kind: 'answer', id: newId(), status: 'pending', line, notes: [], results: [], cuts: [],
      canMore: false, canRelaxLength: false, writing: false, canRetry: false, conditions,
    };
    tab.messages.push(answer);
    const timers = [1, 5, 9, 13, 17, 21, 25, 29, 30].map((seconds, index) => setTimeout(() => {
      if (disposed || answer.status !== 'pending' || !findAnswer(answer.id)) return;
      answer.waiting = options.reducedMotion?.() ? sentences.waiting[0]
        : seconds === 30 ? sentences.waitingLong : sentences.waiting[index % 3];
      emit();
    }, seconds * 1000));
    waitingTimers.set(answer.id, timers);
    return answer;
  };

  const resolveReference = (input: Parameters<ChatStore['send']>[0], base: ChatConditions): ChatReference | undefined | 'notAnalyzed' => {
    if (input.reference) return input.reference.embedding.length ? input.reference : 'notAnalyzed';
    if (input.replyTo?.soundId) {
      const sound = options.sounds().find((item) => item.id === input.replyTo!.soundId);
      if (sound) {
        return sound.embedding ? referenceFor(sound) : 'notAnalyzed';
      }
    }
    return base.reference;
  };

  const send = async (input: Parameters<ChatStore['send']>[0], retry?: RetryRequest): Promise<void> => {
    const tab = tabs.find((item) => item.id === activeTabId)!;
    const text = input.text.trim();
    const continued = retry ? retry.continued : input.replyTo ? findAnswer(input.replyTo.answerId)?.answer : lastAnswer(tab);
    const base = retry ? retry.base : input.replyTo && continued ? continued.conditions : tab.base;
    const resolved = resolveReference(input, base);
    if (!text && !input.reference && !input.replyTo?.soundId) return;
    const reference = resolved === 'notAnalyzed' ? undefined : resolved;
    const quoted = text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text : undefined;
    const words = quoted ? nonHangulWords(quoted.slice(1, -1)) : text ? nonHangulWords(text) : base.auto.words;
    const replied = input.replyTo && continued;
    const user: ChatUserMessage = {
      kind: 'user', id: newId(), text: input.text,
      ...(input.reference ? { reference: input.reference } : reference && input.replyTo?.soundId ? { reference } : {}),
      ...(replied ? {
        replyTo: {
          answerId: continued.id, ...(input.replyTo!.soundId ? { soundId: input.replyTo!.soundId } : {}),
          label: input.replyTo!.soundId && reference ? reference.name : answerLines(continued)[0] ?? '',
        },
      } : {}),
    };
    tab.messages.push(user);
    if (tab.title === newTitle) {
      tab.title = text ? text.slice(0, 16) : reference?.name ?? newTitle;
    }

    if (resolved === 'notAnalyzed' || [...text].length > maxRequestLength) {
      const answer = start(tab, { ...base }, resolved === 'notAnalyzed' ? sentences.notAnalyzed : sentences.tooLong);
      answer.status = 'failed';
      answer.error = resolved === 'notAnalyzed' ? 'notAnalyzed' : 'limit';
      stopWaiting(answer);
      requests.set(answer.id, { input, base, continued });
      record(answer, {});
      emit();
      return;
    }

    // Reference only or quoted text: no Haiku call (PRD 7.3).
    if (quoted || !text) {
      const conditions: ChatConditions = quoted
        ? { sentences: [], auto: autoConditions(undefined, words), reference }
        : { ...base, reference };
      const answer = start(tab, conditions);
      tab.pending++;
      emit();
      let embeddings: Vector[] = [];
      if (!quoted && conditions.sentences.length) {
        embeddings = await platform.embedText(conditions.sentences, abort.signal).catch(() => []);
        if (disposed) return;
      }
      answer.line = quoted ? sentences.quoted : '';
      const facts = finish(answer, { tab, embeddings, quoted, count: batch, request: text }, 'done');
      if (!answer.results.length) answer.line = '';
      await settle(answer, facts, { kind: 'referenceOnly', call: false });
      tab.pending--;
      emit();
      return;
    }

    // File-name matches first while Haiku and the text model work.
    const early: ChatConditions = { sentences: [], auto: autoConditions(undefined, words), length: base.length, reference };
    const answer = start(tab, early);
    const matches = rank(options.sounds(), { ...rankOptions({ ...early, reference: undefined }, []), exclude: tab.shown, count: batch })
      .results.filter((item) => item.textMatched);
    answer.results = matches;
    requests.set(answer.id, { input, base, continued });
    tab.pending++;
    emit();

    const previousDurations = continued?.results.map(({ sound }) => sound.duration) ?? [];
    const hasPrevious = base.sentences.length > 0 || base.auto.names.length > 0 || base.length !== undefined;
    const previous: SearchPlan | undefined = hasPrevious ? {
      sentences: base.sentences, names: base.auto.names, length: base.length, relative: base.relative,
      message: continued?.planMessage || '이전 조건',
    } : undefined;
    let plan: SearchPlan;
    const planBegan = performance.now();
    let planMs = 0;
    try {
      plan = await platform.plan({
        text, hasReference: Boolean(reference), referenceDuration: reference?.duration, previous,
      }, abort.signal);
      planMs = Math.round(performance.now() - planBegan);
    } catch (error) {
      if (disposed || !findAnswer(answer.id)) return;
      planMs = Math.round(performance.now() - planBegan);
      const code = failureCode(error);
      // Korean sentences never go to the text embedding model; English requests still use CLAP.
      const embeddings = !reference && /^[\x20-\x7e]+$/.test(text)
        ? await platform.embedText([text], abort.signal).catch(() => [])
        : [];
      if (disposed || !findAnswer(answer.id)) return;
      answer.line = code === 'dailyLimit' ? sentences.dailyLimit : reference ? sentences.referenceUnread : sentences.unavailable;
      answer.error = code;
      const facts = finish(answer, { tab, embeddings, count: batch, request: text }, 'failed');
      await settle(answer, facts, { kind: 'search', call: false, planMs });
      tab.pending--;
      emit();
      return;
    }
    if (disposed || !findAnswer(answer.id)) return;
    answer.planMessage = plan.message;
    const planned = plan.sentences.length ? plan.sentences : base.sentences;
    const fresh = autoConditions(plan);
    // A length-only request ("더 짧게") keeps what Haiku picked before.
    // A count-only request ("5개 찾아줘") repeats the sentences and may drop the file words picked before.
    const repeated = plan.sentences.length > 0 && plan.sentences.join('\n') === base.sentences.join('\n') && noAuto(fresh);
    const auto = repeated || (!plan.sentences.length && (plan.relative || plan.length || noAuto(fresh)))
      ? base.auto : { ...fresh, words };
    const length = plan.relative
      ? relativeLength(plan.relative, reference?.duration, previousDurations, base.relative === plan.relative)
      : plan.length ?? (plan.sentences.length && !repeated ? undefined : base.length);
    answer.conditions = {
      sentences: planned, auto, reference,
      ...(length ? { length } : {}), ...(plan.relative ? { relative: plan.relative } : {}),
    };
    let embeddings: Vector[] = [];
    let failed = false;
    if (planned.length) {
      try {
        embeddings = await platform.embedText(planned, abort.signal);
      } catch {
        failed = true;
      }
      if (disposed || !findAnswer(answer.id)) return;
    }
    answer.line = '';
    if (failed) answer.error = 'model';
    const facts = finish(answer, {
      tab, embeddings, count: plan.count ?? batch, request: text, plan, refinement: hasPrevious,
      changed: plan.relative && length ? plan.relative : null,
    }, failed ? 'failed' : 'done');
    await settle(answer, facts, { kind: 'search', call: !failed && answer.results.length > 0, planMs });
    tab.pending--;
    emit();
  };

  return {
    getState,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    newTab() {
      const tab = makeTab();
      tabs.push(tab);
      activeTabId = tab.id;
      emit();
      return tab.id;
    },
    closeTab(tabId) {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      for (const message of tabs[index].messages) {
        if (message.kind !== 'answer') continue;
        stopWaiting(message);
        phraseControllers.get(message.id)?.abort();
        requests.delete(message.id);
        rankings.delete(message.id);
      }
      tabs.splice(index, 1);
      if (!tabs.length) tabs = [makeTab()];
      if (activeTabId === tabId) activeTabId = tabs[Math.min(index, tabs.length - 1)].id;
      emit();
    },
    selectTab(tabId) {
      if (!tabs.some((tab) => tab.id === tabId)) return;
      activeTabId = tabId;
      emit();
    },
    send,
    async retry(answerId) {
      const found = findAnswer(answerId);
      const input = requests.get(answerId);
      if (!found?.answer.canRetry || !input) return;
      found.answer.canRetry = false;
      activeTabId = found.tab.id;
      await send(input.input, input);
    },
    async more(answerId) {
      const found = findAnswer(answerId);
      const ranking = rankings.get(answerId);
      if (!found || !ranking || !found.answer.canMore) return;
      const { tab, answer } = found;
      const result = rank(options.sounds(), { ...searchOptions(answer.conditions, ranking), exclude: tab.shown, count: batch });
      for (const { sound } of result.results) {
        tab.shown.add(sound.id);
        if (sound.fullHash) tab.shown.add(sound.fullHash);
      }
      if (result.results.length) answer.cuts.push(answer.results.length);
      answer.results = [...answer.results, ...result.results];
      answer.canMore = result.hasMore;
      if (!result.hasMore) answer.closing = sentences.exhausted;
      emit();
    },
    async relaxLength(answerId) {
      const found = findAnswer(answerId);
      const ranking = rankings.get(answerId);
      if (!found || !ranking) return;
      const { length: _length, relative: _relative, ...conditions } = found.answer.conditions;
      const answer = start(found.tab, conditions);
      answer.planMessage = found.answer.planMessage;
      answer.error = found.answer.error;
      const facts = finish(answer, { ...ranking }, found.answer.status === 'failed' ? 'failed' : 'done');
      const original = requests.get(found.answer.id);
      if (original) requests.set(answer.id, { ...original, base: conditions });
      await settle(answer, facts, { kind: 'relaxLength', call: false });
      emit();
    },
    removeChip(chipId) {
      const tab = tabs.find((item) => item.id === activeTabId)!;
      const base = { ...tab.base };
      const [kind, ...rest] = chipId.split(':');
      const label = rest.join(':');
      if (kind === 'reference') delete base.reference;
      else if (kind === 'length') { delete base.length; delete base.relative; }
      else if (kind === 'sentence') {
        base.sentences = base.sentences.filter((item) => item !== label);
        if (!base.sentences.length) base.auto = autoConditions();
      }
      tab.base = base;
      emit();
    },
    refresh() {
      refreshAvailable();
      emit();
    },
    dispose() {
      disposed = true;
      abort.abort();
      for (const timers of waitingTimers.values()) for (const timer of timers) clearTimeout(timer);
      waitingTimers.clear();
      for (const controller of phraseControllers.values()) controller.abort();
      listeners.clear();
    },
  };
}
