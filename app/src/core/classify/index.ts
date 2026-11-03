import { cosineSimilarity, type Vector } from '../search';
import { CAT_IDS, CATEGORIES, CATEGORY_SCALE, CATEGORY_TEXT_BASE64, DEFAULT_CATEGORIES } from './ucs-data.generated';

const THRESHOLD = 0.95;
const GENERIC_WORDS = new Set(['RAIN', 'WIND', 'HAIL', 'STORM', 'MIX', 'RAW', 'REF', 'TEST', 'PROD', 'ASSET']);
const catIdsByLowerCase = new Map(Object.entries(CAT_IDS).map(([id, category]) => [id.toLowerCase(), { id, category }]));

export type ClassifyState = 'unclassified' | 'name' | 'human' | 'card';
/** Saved data from the removed AI batches may still hold { excluded: true }; it counts as no decision. */
export type ClassifyDecision = { category: string };
export type ClassifyDecisions = Readonly<Record<string, ClassifyDecision>>;

export interface ClassifySound {
  id: string;
  folder: string;
  relativePath: string;
  fullHash: string;
  embedding?: Vector;
}

export interface ClassifiedSound {
  id: string;
  fullHash: string;
  relativePath: string;
  state: ClassifyState;
  category?: string;
}

export interface ClassifyCard {
  id: string;
  soundIds: string[];
  candidates: string[];
  nameCategory?: string;
}

export interface ClassifyOverview {
  sounds: ClassifiedSound[];
  cards: ClassifyCard[];
}

export interface CategoryModel {
  scale: number;
  vector(category: string): Vector;
}

export interface CategoryScore {
  category: string;
  probability: number;
}

export function readUcsName(fileName: string): string | undefined {
  const name = fileName.split(/[\\/]/).pop()!;
  const underscore = name.indexOf('_');
  if (underscore < 0) return undefined;
  const code = name.slice(0, underscore).split('-')[0];
  const entry = catIdsByLowerCase.get(code.toLowerCase());
  if (!entry || (GENERIC_WORDS.has(entry.id) && code !== entry.id)) return undefined;
  return entry.category;
}

let textVectors: Float32Array | undefined;
const defaultModel: CategoryModel = {
  scale: CATEGORY_SCALE,
  vector(category) {
    textVectors ??= new Float32Array(Uint8Array.from(atob(CATEGORY_TEXT_BASE64), (char) => char.charCodeAt(0)).buffer);
    const index = CATEGORIES.indexOf(category);
    return textVectors.subarray(index * 512, (index + 1) * 512);
  },
};

export function scoreCategories(embedding: Vector, categories: readonly string[], model: CategoryModel = defaultModel): CategoryScore[] {
  const logits = categories.map((category) => model.scale * cosineSimilarity(embedding, model.vector(category)));
  const top = Math.max(...logits);
  const weights = logits.map((logit) => Math.exp(logit - top));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return categories.map((category, index) => ({ category, probability: weights[index] / total }))
    .sort((a, b) => b.probability - a.probability);
}

export function numberGroupKey(folder: string, relativePath: string): string | undefined {
  const parts = relativePath.split(/[\\/]/);
  const name = parts.pop()!;
  const stem = name.replace(/\.[^.]*$/, '');
  if (!/\d/.test(stem) || !/\p{L}/u.test(stem)) return undefined;
  return [folder, ...parts, name.replace(/\d+/g, '#')].join('/');
}

export function isClassifyDecision(value: unknown): value is ClassifyDecision {
  return typeof value === 'object' && value !== null && typeof (value as { category?: unknown }).category === 'string';
}

export function applyDecision(existing: ClassifyDecision | undefined, next: ClassifyDecision): ClassifyDecision {
  return isClassifyDecision(existing) ? existing : next;
}

/** A name card disagrees with the name, so the name's category is the first choice and the sound's best follow (PRD 7.4). */
const withName = (scores: readonly CategoryScore[], named: string) =>
  [named, ...scores.map((score) => score.category).filter((category) => category !== named)].slice(0, 3);

function groupCandidates(scores: readonly CategoryScore[][]): string[] {
  const totals = new Map<string, number>();
  for (const score of scores.flat()) totals.set(score.category, (totals.get(score.category) ?? 0) + score.probability);
  return [...totals].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category]) => category);
}

export function classifyLibrary(
  sounds: readonly ClassifySound[],
  decisions: ClassifyDecisions,
  model: CategoryModel = defaultModel,
): ClassifyOverview {
  const seen = new Set<string>();
  const unique = sounds.filter(({ id }) => !seen.has(id) && seen.add(id));
  const classified: ClassifiedSound[] = [];
  const cards: ClassifyCard[] = [];
  const groups = new Map<string, { soundIds: string[]; scores: CategoryScore[][] }>();
  for (const sound of unique) {
    const base = { id: sound.id, fullHash: sound.fullHash, relativePath: sound.relativePath };
    const decision = decisions[sound.fullHash];
    if (isClassifyDecision(decision)) {
      classified.push({ ...base, state: 'human', category: decision.category });
      continue;
    }
    const named = readUcsName(sound.relativePath);
    if (named) {
      const list = (DEFAULT_CATEGORIES as readonly string[]).includes(named) ? DEFAULT_CATEGORIES : [...DEFAULT_CATEGORIES, named];
      const scores = sound.embedding && scoreCategories(sound.embedding, list, model);
      const conflict = scores && scores[0].category !== named && scores[0].probability >= THRESHOLD;
      classified.push({ ...base, state: conflict ? 'card' : 'name', category: named });
      if (conflict) cards.push({ id: `name:${sound.id}`, soundIds: [sound.id], candidates: withName(scores, named), nameCategory: named });
      continue;
    }
    if (!sound.embedding) {
      classified.push({ ...base, state: 'unclassified' });
      continue;
    }
    const scores = scoreCategories(sound.embedding, DEFAULT_CATEGORIES, model);
    classified.push({ ...base, state: 'card' });
    const key = numberGroupKey(sound.folder, sound.relativePath) ?? `file:${sound.id}`;
    const group = groups.get(key) ?? { soundIds: [], scores: [] };
    group.soundIds.push(sound.id);
    group.scores.push(scores);
    groups.set(key, group);
  }
  for (const [id, group] of groups) cards.push({ id, soundIds: group.soundIds, candidates: groupCandidates(group.scores) });
  return { sounds: classified, cards };
}
