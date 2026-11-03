export interface PhraseFacts {
  readonly count: number;
  readonly requested_count: number;
  readonly packs: readonly { readonly name: string; readonly count: number }[];
  readonly main_pack: string | null;
  readonly length_range: string | null;
  readonly length_condition: string | null;
  readonly first_file: string | null;
  readonly is_low_score: boolean;
  readonly has_reference: boolean;
  readonly reference_pack_avoided: boolean;
  readonly is_refinement: boolean;
  readonly changed: 'shorter' | 'longer' | null;
  readonly more_available: boolean;
  readonly is_short: boolean;
  readonly already_shown_excluded: boolean;
  readonly removed_by_length: number;
}

class PhraseError extends Error {
  constructor() { super('INVALID_PHRASE'); }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && [...value].length <= max && !/[\r\n]/u.test(value);
const nullableText = (value: unknown, max: number): value is string | null => value === null || text(value, max);

/** Public relay and IPC boundary. Limits keep the facts within a 2 KB request. */
export function parsePhraseFacts(value: unknown): PhraseFacts {
  if (!object(value)) throw new PhraseError();
  const {
    count, requested_count, packs, main_pack, length_range, length_condition, first_file,
    is_low_score, has_reference, reference_pack_avoided, is_refinement, changed,
    more_available, is_short, already_shown_excluded, removed_by_length,
  } = value;
  const keys = ['count', 'requested_count', 'packs', 'main_pack', 'length_range', 'length_condition',
    'first_file', 'is_low_score', 'has_reference', 'reference_pack_avoided', 'is_refinement', 'changed',
    'more_available', 'is_short', 'already_shown_excluded', 'removed_by_length'];
  if (Object.keys(value).some((key) => !keys.includes(key))
    || !integer(count, 10) || !integer(requested_count, 10)
    || !Array.isArray(packs) || packs.length > 10
    || !nullableText(main_pack, 80) || !nullableText(length_range, 40)
    || !nullableText(length_condition, 40) || !nullableText(first_file, 80)
    || typeof is_low_score !== 'boolean' || typeof has_reference !== 'boolean'
    || typeof reference_pack_avoided !== 'boolean' || typeof is_refinement !== 'boolean'
    || (changed !== null && changed !== 'shorter' && changed !== 'longer')
    || typeof more_available !== 'boolean' || typeof is_short !== 'boolean'
    || typeof already_shown_excluded !== 'boolean'
    || typeof removed_by_length !== 'number' || !Number.isSafeInteger(removed_by_length) || removed_by_length < 0) {
    throw new PhraseError();
  }
  const parsedPacks = packs.map((pack: unknown) => {
    if (!object(pack) || Object.keys(pack).some((key) => key !== 'name' && key !== 'count')
      || !text(pack.name, 80) || !integer(pack.count, 10)) throw new PhraseError();
    return { name: pack.name, count: pack.count };
  });
  return { count, requested_count, packs: parsedPacks, main_pack, length_range, length_condition,
    first_file, is_low_score, has_reference, reference_pack_avoided, is_refinement, changed,
    more_available, is_short, already_shown_excluded, removed_by_length };
}

export type PhraseKind = 'search' | 'referenceOnly' | 'relaxLength';

const narrowedTo = (condition: string) => `${condition}${condition.endsWith('이상') ? '으로' : '로'} 좁혀`;

export function fallbackPhrase(facts: PhraseFacts, kind: PhraseKind): string {
  const n = `${facts.count}개${facts.is_short ? '만' : '를'}`;
  const first = facts.more_available ? '먼저 ' : '';
  if (kind === 'relaxLength') return `길이 조건을 해제하고 ${n} ${first}가져왔어요.`;
  if (facts.is_low_score) {
    const beginning = facts.length_condition ? `${facts.length_condition} 중에서 ` : '';
    const invitation = facts.first_file ? `${facts.first_file}부터 ` : '';
    return `${beginning}가장 가까운 ${n} ${first}골랐어요. ${invitation}${facts.length_condition ? '들어 보세요.' : '들어 보고 더 자세히 말해 주세요.'}`;
  }
  if (facts.is_refinement && facts.changed !== null) {
    const change = facts.changed === 'shorter' ? '앞 결과보다 짧은 소리로' : '앞 결과보다 긴 소리로';
    return `${change} ${n} ${first}가져왔어요.`;
  }
  if (facts.has_reference) {
    const other = facts.reference_pack_avoided ? '다른 팩에서 ' : '';
    return `넣어 주신 소리와 비슷한 ${n} ${other}${first}가져왔어요.`;
  }
  if (facts.length_condition) return `${narrowedTo(facts.length_condition)} ${n} ${first}가져왔어요.`;
  const pack = facts.main_pack ? `${facts.main_pack} 팩을 중심으로 `
    : facts.packs.length === 1 ? `${facts.packs[0]?.name} 팩에서 ` : '';
  return `${pack}${n} ${first}가져왔어요.${facts.length_range ? ` 길이는 ${facts.length_range}예요.` : ''}`;
}

/** Reject, never repair: names are data, and all remaining claims must come from facts. */
export function checkPhrase(message: string, facts: PhraseFacts): boolean {
  const escaped = facts.first_file?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const withoutFile = escaped ? message.replace(new RegExp(`(?<![\\p{L}\\p{N}_.-])${escaped}(?![A-Za-z0-9_.-])`, 'gu'), '') : message;
  // Names are data like file names: their length, periods and digits are no claims.
  const withoutNames = facts.packs.reduce((text, { name }) => text.split(name).join(''), withoutFile);
  if ([...withoutNames].length > 90 || /[\r\n!~\uFE0F\u20E3]|\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(message)
    || !message.endsWith('요.') || /[가-힣]*(?:게요|거예요|겠)/u.test(withoutFile)) return false;
  // Periods in decimal lengths are not sentence boundaries.
  const endings = withoutNames.replace(/\d+\.\d+/gu, '0').match(/\./gu) ?? [];
  if (endings.length < 1 || endings.length > 2) return false;
  if (/[^\s]+\.[a-zA-Z][a-zA-Z0-9]{1,7}/u.test(withoutNames)) return false;
  const allowedNumbers = new Set([String(facts.count),
    ...(facts.length_range?.match(/\d+(?:\.\d+)?/gu) ?? []),
    ...(facts.length_condition?.match(/\d+(?:\.\d+)?/gu) ?? [])]);
  const numbers: string[] = withoutNames.match(/\d+(?:\.\d+)?/gu) ?? [];
  if (!numbers.includes(String(facts.count)) || numbers.some((n) => !allowedNumbers.has(n))) return false;
  const latin = new Set(facts.packs.flatMap(({ name }) => name.match(/[A-Za-z]+/gu) ?? []));
  if ((withoutFile.match(/[A-Za-z]+/gu) ?? []).some((word) => !latin.has(word))) return false;
  if (/없어요|없습니다|없는|묵직|날카|부드|경쾌|따뜻|차가|시원|강렬|깔끔|풍부|낮고|높고|어둡|밝은|완벽|딱|좋은|추천|점수|기준값|모델|설명으로|파일 이름으로|임베딩|CLAP|Haiku|기준 소리|본보기/u.test(withoutFile)) return false;
  if (facts.is_low_score && (/찾았|가져왔|맞는|어울/u.test(withoutFile)
    || !withoutFile.includes('가장 가까운') || !withoutFile.includes('골랐'))) return false;
  if (!facts.is_low_score && withoutFile.includes('가장 가까운')) return false;
  if (facts.length_condition === null && /좁혀|이하|이상/u.test(withoutFile)) return false;
  if (facts.changed === null && withoutFile.includes('앞 결과')) return false;
  if (!facts.reference_pack_avoided && withoutFile.includes('다른 팩')) return false;
  if (!facts.is_low_score && !/(?:어요|예요|이에요)\.$/u.test(withoutFile)) return false;
  return true;
}

export async function requestPhrase(endpoint: string, facts: PhraseFacts, signal?: AbortSignal): Promise<string> {
  // The relay cuts its own call at 8 or 35 seconds; this only ends a connection that never answers.
  const deadline = AbortSignal.timeout(40_000);
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(facts), signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  const value: unknown = await response.json();
  if (!response.ok || !object(value) || typeof value.message !== 'string') throw new PhraseError();
  return value.message;
}
