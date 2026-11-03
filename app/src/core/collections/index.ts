import type { LengthCondition, SearchSound } from '../search';

/** Entries are references only: a sound by whole-file hash, a folder by connected root and relative path. */
export type CollectionEntry =
  | { kind: 'sound'; hash: string; path: string }
  | { kind: 'folder'; root: string; path: string };

export interface Collection {
  id: string;
  name: string;
  entries: CollectionEntry[];
}

export interface SavedReference {
  name: string;
  duration: number;
  embedding: number[];
  fullHash?: string;
  packIds?: string[];
}

/** The request and finished conditions; rerunning needs no new plan when sentences or names exist. */
export interface SearchConditions {
  query: string;
  sentences: string[];
  names: string[];
  length?: LengthCondition;
  reference?: SavedReference;
  collectionId?: string;
  category?: string;
  /** The plan finished, even if it left only a length condition. */
  planned?: boolean;
  relative?: 'shorter' | 'longer';
}

export interface SavedSearch extends SearchConditions {
  id: string;
  name: string;
}

export interface CollectionData {
  collections: Collection[];
  /** Kept so old files still load; v3 no longer saves searches. */
  searches: SavedSearch[];
  /** Whole-file hashes of favourite sounds (the heart). Absent in files written before v3. */
  favorites?: string[];
}

const directorySeparators = /[/\\]/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const isOptionalNumber = (value: unknown) => value === undefined || Number.isFinite(value);

function isEntry(value: unknown): value is CollectionEntry {
  if (!isObject(value) || typeof value.path !== 'string') return false;
  if (value.kind === 'sound') return typeof value.hash === 'string' && value.hash !== '';
  return value.kind === 'folder' && typeof value.root === 'string' && value.root !== '';
}

function isReference(value: unknown): boolean {
  return isObject(value) && typeof value.name === 'string' && Number.isFinite(value.duration) &&
    Array.isArray(value.embedding) && value.embedding.every(Number.isFinite) &&
    (value.fullHash === undefined || typeof value.fullHash === 'string') &&
    (value.packIds === undefined || isStrings(value.packIds));
}

function isSearch(value: unknown): boolean {
  return isObject(value) && typeof value.id === 'string' && typeof value.name === 'string' &&
    typeof value.query === 'string' && isStrings(value.sentences) && isStrings(value.names) &&
    (value.length === undefined || (isObject(value.length) &&
      isOptionalNumber(value.length.min) && isOptionalNumber(value.length.max))) &&
    (value.reference === undefined || isReference(value.reference)) &&
    (value.collectionId === undefined || typeof value.collectionId === 'string') &&
    (value.category === undefined || typeof value.category === 'string') &&
    (value.planned === undefined || typeof value.planned === 'boolean') &&
    (value.relative === undefined || value.relative === 'shorter' || value.relative === 'longer');
}

export function isCollectionData(value: unknown): value is CollectionData {
  return isObject(value) && Array.isArray(value.searches) && value.searches.every(isSearch) &&
    (value.favorites === undefined || (isStrings(value.favorites) && value.favorites.every((hash) => hash !== ''))) &&
    Array.isArray(value.collections) && value.collections.every((collection) =>
      isObject(collection) && typeof collection.id === 'string' && typeof collection.name === 'string' &&
      Array.isArray(collection.entries) && collection.entries.every(isEntry));
}

export function soundEntry(sound: SearchSound): CollectionEntry | undefined {
  return sound.fullHash ? { kind: 'sound', hash: sound.fullHash, path: sound.relativePath } : undefined;
}

/** The folder directly containing the sound; an empty path is the connected folder itself. */
export function folderEntry(sound: SearchSound): CollectionEntry | undefined {
  if (!sound.root) return undefined;
  return { kind: 'folder', root: sound.root, path: sound.relativePath.split(directorySeparators).slice(0, -1).join('/') };
}

function sameEntry(a: CollectionEntry, b: CollectionEntry): boolean {
  if (a.kind === 'sound') return b.kind === 'sound' && a.hash === b.hash;
  return b.kind === 'folder' && a.root === b.root && a.path === b.path;
}

export function addEntry(entries: readonly CollectionEntry[], entry: CollectionEntry): CollectionEntry[] {
  return entries.some((saved) => sameEntry(saved, entry)) ? [...entries] : [...entries, entry];
}

export function removeEntry(entries: readonly CollectionEntry[], entry: CollectionEntry): CollectionEntry[] {
  return entries.filter((saved) => !sameEntry(saved, entry));
}

function entryContains(entry: CollectionEntry, sound: SearchSound): boolean {
  if (entry.kind === 'sound') return sound.fullHash === entry.hash;
  if (sound.root !== entry.root) return false;
  return entry.path === '' || sound.relativePath.split(directorySeparators).join('/').startsWith(`${entry.path}/`);
}

export function inCollection(collection: Collection, sound: SearchSound): boolean {
  return collection.entries.some((entry) => entryContains(entry, sound));
}

export interface ResolvedEntry {
  entry: CollectionEntry;
  /** Current path when available, otherwise the last path seen. */
  path: string;
  available: boolean;
  soundCount: number;
}

/** A missing target only changes the result; the entry itself is always kept. */
export function resolveEntries(collection: Collection, sounds: readonly SearchSound[]): ResolvedEntry[] {
  return collection.entries.map((entry) => {
    const matched = sounds.filter((sound) => entryContains(entry, sound));
    return {
      entry, available: matched.length > 0, soundCount: matched.length,
      path: entry.kind === 'sound' ? matched[0]?.relativePath ?? entry.path : entry.path,
    };
  });
}
