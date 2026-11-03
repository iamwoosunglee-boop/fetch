import { CATEGORY_NAMES } from '../classify/labels';
import { SEARCH_TUNING, scoreSound, type SearchTuning } from './scoring';
export { SEARCH_TUNING, scoreSound } from './scoring';

export function tokenize(value: string): string[] {
  return value
    .normalize('NFC')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function hasHangul(value: string): boolean {
  return /\p{Script=Hangul}/u.test(value);
}

/** Typed words without Hangul; chat matches file names on any one of them (PRD 7.3). */
export function nonHangulWords(value: string): string[] {
  return value.split(/\s+/u).filter((word) => tokenize(word).length > 0 && !hasHangul(word));
}

/**
 * relativePath must start below the connected folder, not at its absolute root.
 * 'all': every typed word must match (list search box, quoted search).
 * 'any': one typed word without Hangul is enough (chat); a name keyword always needs all its words.
 */
export function textMatch(
  relativePath: string, query: string, names: readonly string[] = [], mode: 'all' | 'any' = 'all',
): boolean {
  const words = new Set(tokenize(relativePath));
  const matches = (value: string) => {
    const tokens = tokenize(value);
    return tokens.length > 0 && tokens.every((token) => words.has(token));
  };
  const typed = mode === 'all' ? matches(query) : nonHangulWords(query).some(matches);
  return typed || names.some(matches);
}

export interface LengthCondition {
  min?: number;
  max?: number;
}

export function lengthFilter(duration: number, condition?: LengthCondition): boolean {
  const { min, max } = condition ?? {};
  // Allow rounding from relative-length and margin arithmetic, scaled to each bound.
  return (min === undefined || duration >= min - min * 0.1 - min * Number.EPSILON * 2)
    && (max === undefined || duration <= max + max * 0.1 + max * Number.EPSILON * 2);
}

/** Repeated refinements use the latest result lengths, even with a reference. */
export function relativeLength(
  direction: 'shorter' | 'longer',
  referenceDuration?: number,
  previousDurations: readonly number[] = [],
  repeated = false,
): LengthCondition | undefined {
  let base = repeated ? undefined : referenceDuration;
  if (base === undefined && previousDurations.length > 0) {
    const sorted = [...previousDurations].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    base = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  }
  if (base === undefined) return undefined;
  return direction === 'shorter' ? { max: base * 70 / 100 } : { min: base * 130 / 100 };
}

export function lengthLabel({ min, max }: LengthCondition): string {
  const seconds = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
  if (min !== undefined && max !== undefined) return `${seconds(min)}초부터 ${seconds(max)}초까지`;
  return min !== undefined ? `${seconds(min)}초 이상` : `${seconds(max ?? 0)}초 이하`;
}

export type Vector = readonly number[] | Float32Array;

/** Embeddings supplied by the model share the same dimension. */
export function cosineSimilarity(a: Vector, b: Vector): number {
  let dot = 0;
  let aSquared = 0;
  let bSquared = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aSquared += a[i] * a[i];
    bSquared += b[i] * b[i];
  }
  return aSquared === 0 || bSquared === 0 ? 0 : dot / Math.sqrt(aSquared * bSquared);
}

/** Inputs are cosine scores, one per text sentence and optionally the reference. */
export function combineScores(sentenceScores: readonly number[], referenceScore?: number): number {
  const textScore = sentenceScores.length > 0 ? Math.max(...sentenceScores) : undefined;
  if (textScore === undefined) return referenceScore ?? 0;
  return referenceScore === undefined ? textScore : (textScore + referenceScore) / 2;
}

export interface ConnectedFolder {
  root: string;
  /** File paths relative to root, including the filename. */
  files: readonly string[];
}

export interface PackAssignment {
  root: string;
  relativePath: string;
  packId: string;
  packName: string;
}

/** The English words of the 82 UCS categories; "DIRT & SAND" gives both words. */
const categoryWords = new Set(CATEGORY_NAMES.flatMap((category) => tokenize(category)));

/** At least half of the folder names carry a category word, so they are sound types, not packs (PRD 7.3 팩 구분). */
function namesSoundTypes(folders: ReadonlySet<string>): boolean {
  const matched = [...folders].filter((name) => tokenize(name).some((word) => categoryWords.has(word)));
  return matched.length * 2 >= folders.size;
}

/** Uses path strings only; callers supply the scan results. */
export function detectPacks(folders: readonly ConnectedFolder[]): PackAssignment[] {
  return folders.flatMap(({ root, files }) => {
    const rootPath = root.replace(/\\/g, '/').replace(/\/+$/, '');
    const rootName = rootPath.split('/').pop() || root;
    const directories = files.map((file) => file.replace(/\\/g, '/').split('/').slice(0, -1));
    let packDepth = 0;
    for (let level = 0; directories.some((parts) => parts.length > level); level++) {
      const children = new Set(directories.filter((parts) => parts.length > level).map((parts) => parts[level]));
      if (children.size >= 2) {
        packDepth = namesSoundTypes(children) ? level : level + 1;
        break;
      }
    }
    return files.map((relativePath, index) => {
      const parts = directories[index];
      const inPack = packDepth > 0 && parts.length >= packDepth;
      return {
        root, relativePath,
        packId: inPack ? `${rootPath}/${parts.slice(0, packDepth).join('/')}` : rootPath,
        packName: inPack ? parts[packDepth - 1] : rootName,
      };
    });
  });
}

export interface SearchSound {
  id: string;
  /** Connected folder containing relativePath; absent for the web demo. */
  root?: string;
  relativePath: string;
  packId: string;
  /** Every pack holding this content, once uniqueSounds merged identical files. */
  packIds?: readonly string[];
  /** Ids of the rows merged into this sound; web rows have one id per path. */
  mergedIds?: readonly string[];
  /** Display name of the pack (detectPacks packName). */
  packName?: string;
  duration: number;
  /** Only a verified whole-file hash may be supplied here. */
  fullHash?: string;
  embedding?: Vector;
  /** Row waveform: 48 peak values from 0 to 1, stored during analysis. Absent until analysed. */
  peaks?: readonly number[];
  /** When the sound first entered the library, in epoch milliseconds; drives "최근 가져온 순". */
  addedAt?: number;
  /** Set while the file cannot be reached; playback and dragging stay blocked. */
  blockedReason?: string;
}

export interface SearchReference {
  embedding: Vector;
  fullHash?: string;
  /** Omit for an external reference; include every pack containing an internal reference. */
  packIds?: readonly string[];
}

export interface RankOptions {
  query?: string;
  names?: readonly string[];
  fileWords?: readonly string[];
  typicalMaxSeconds?: number | null;
  tuning?: SearchTuning;
  commonScores?: ReadonlyMap<string, number>;
  textEmbeddings?: readonly Vector[];
  reference?: SearchReference;
  length?: LengthCondition;
  /** Sound ids and full hashes already shown in the tab; never returned. */
  exclude?: ReadonlySet<string>;
  /** Batch size; defaults to 3. */
  count?: number;
  /** How typed words match file names; quoted input always uses 'all'. Defaults to 'all'. */
  textMode?: 'all' | 'any';
  /** Keep only file-name matches, as with quoted input; for searches with no sentence or reference to rank by. */
  matchedOnly?: boolean;
}

export interface RankedSound {
  sound: SearchSound;
  score: number;
  rawScore?: number;
  textMatched: boolean;
}

export interface SearchResults {
  results: RankedSound[];
  /** Unseen candidates remain after this batch. */
  hasMore: boolean;
  /** Sounds the length condition removed. */
  lengthRemoved: number;
  /**
   * The best raw score does not clear the cut of its branch, so the search cannot claim a find (PRD 7.3).
   * Shown sounds count: a follow-up is not weak because its best sounds were already shown.
   * No decision when a file name leads the answer or for a quoted search.
   * A null cut decides for text and both; a null reference cut keeps the reference sentences.
   */
  uncertain: boolean;
}

export function rankResults(sounds: readonly SearchSound[], options: RankOptions = {}): SearchResults {
  const { reference, length, names = [], textEmbeddings = [], exclude, count = 3 } = options;
  const query = (options.query ?? '').trim();
  const quoted = query.length >= 2 && query.startsWith('"') && query.endsWith('"');
  const mode = quoted ? 'all' : options.textMode ?? 'all';
  const eligible = sounds.filter((sound) => reference?.fullHash === undefined || sound.fullHash !== reference.fullHash);
  const lengthPassed = eligible.filter((sound) => lengthFilter(sound.duration, length));
  const tuning = options.tuning ?? SEARCH_TUNING;
  const scored = lengthPassed.map((sound): RankedSound => {
    const embedding = sound.embedding;
    const words = new Set(tokenize(sound.relativePath));
    return {
      sound,
      textMatched: textMatch(sound.relativePath, query, quoted ? [] : names, mode),
      ...scoreSound({
        sentenceScores: embedding ? textEmbeddings.map((sentence) => cosineSimilarity(embedding, sentence)) : [],
        referenceScore: embedding && reference ? cosineSimilarity(embedding, reference.embedding) : undefined,
        commonScore: options.commonScores?.get(sound.id),
        matchingWords: [...new Set(options.fileWords ?? [])].filter((word) => words.has(word)).length,
        duration: sound.duration, typicalMaxSeconds: options.typicalMaxSeconds,
        explicitLength: length?.min !== undefined || length?.max !== undefined,
      }, tuning),
    };
  });
  const ranked = scored.filter(({ sound }) => !exclude
    || (!exclude.has(sound.id) && (sound.fullHash === undefined || !exclude.has(sound.fullHash))));
  // Identical files are one sound; keep the path the text matched, if any.
  const unique = new Map<string, RankedSound>();
  for (const item of ranked) {
    const key = item.sound.fullHash ?? item.sound.id;
    const kept = unique.get(key);
    if (!kept || (item.textMatched && !kept.textMatched)) unique.set(key, item);
  }
  const referencePacks = new Set(reference?.packIds ?? []);
  const inReferencePack = (sound: SearchSound) =>
    (sound.packIds ?? [sound.packId]).some((pack) => referencePacks.has(pack));
  const candidates = [...unique.values()]
    .filter((item) => !(quoted || options.matchedOnly) || item.textMatched)
    .sort((a, b) => Number(b.textMatched) - Number(a.textMatched)
      || Number(inReferencePack(a.sound)) - Number(inReferencePack(b.sound)) || b.score - a.score);
  const results = candidates.slice(0, count);
  const branch = reference ? textEmbeddings.length ? 'both' : 'reference' : 'text';
  const cut = tuning.thresholds[branch];
  const bestRawScore = scored.reduce((best, { rawScore = 0 }) => Math.max(best, rawScore), -Infinity);
  return {
    results,
    hasMore: candidates.length > results.length,
    // When only file-name matches count, a sound cut by length only matters if its name matches too.
    lengthRemoved: eligible.filter((sound) => !lengthFilter(sound.duration, length)
      && (!(quoted || options.matchedOnly) || textMatch(sound.relativePath, query, quoted ? [] : names, mode))).length,
    uncertain: (textEmbeddings.length > 0 || reference !== undefined)
      && results.length > 0 && !quoted && !results[0].textMatched
      && (cut === null ? branch !== 'reference' : bestRawScore <= cut),
  };
}
