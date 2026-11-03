import fs from 'node:fs';
import { join } from 'node:path';
import { decisionsCsv, type FileTracking } from '../core/files';
import { isCollectionData, type CollectionData } from '../core/collections';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface StoreItem {
  id: string;
  fullSha256: string;
  paths: { folderId: string; path: string }[];
  size?: number;
  mtimeMs?: number;
  edgeSha256?: string;
  duration?: number;
  embeddingError?: string;
  /** Row waveform as PEAK_COUNT integers 0-100; empty when the file could not be decoded for it. */
  peaks?: number[];
  /** Epoch ms when the sound first entered the library. Absent for items saved before v3. */
  addedAt?: number;
}

export interface LoadResult<T> {
  data: T;
  warnings: string[];
}

export interface StoredFolder {
  root: string;
}

type Decisions = Record<string, JsonValue>;
const sha256 = /^[a-f0-9]{64}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isItems = (value: unknown): value is StoreItem[] =>
  Array.isArray(value) && value.every((item) =>
    isObject(item) && typeof item.id === 'string' &&
    typeof item.fullSha256 === 'string' && sha256.test(item.fullSha256) &&
    Array.isArray(item.paths) && item.paths.every((entry) =>
      isObject(entry) && typeof entry.folderId === 'string' && typeof entry.path === 'string'));
const isDecisions = (value: unknown): value is Decisions =>
  isObject(value) && Object.keys(value).every((key) => sha256.test(key));
const isFolders = (value: unknown): value is StoredFolder[] =>
  Array.isArray(value) && value.every((folder) => isObject(folder) && typeof folder.root === 'string');

const isTrackedPath = (value: unknown) =>
  isObject(value) && typeof value.folderId === 'string' && typeof value.path === 'string';
const isTracking = (value: unknown): value is FileTracking =>
  isObject(value) &&
  Array.isArray(value.moved) && value.moved.every((entry) => isObject(entry) &&
    typeof entry.folderId === 'string' && typeof entry.from === 'string' && typeof entry.to === 'string') &&
  Array.isArray(value.missing) && value.missing.every((entry) => isObject(entry) &&
    typeof entry.fullSha256 === 'string' && sha256.test(entry.fullSha256) &&
    Array.isArray(entry.paths) && entry.paths.length > 0 && entry.paths.every(isTrackedPath)) &&
  Array.isArray(value.changed) && value.changed.every((entry) => isTrackedPath(entry) && isObject(entry) &&
    typeof entry.fromSha256 === 'string' && sha256.test(entry.fromSha256) &&
    typeof entry.toSha256 === 'string' && sha256.test(entry.toSha256));
const isDurations = (value: unknown): value is Record<string, number> =>
  isObject(value) && Object.values(value).every(Number.isFinite);
const noTracking: FileTracking = { moved: [], missing: [], changed: [] };

// One instance in the main process owns writes to the app.getPath('userData') directory.
export class Store {
  readonly warnings: string[] = [];
  private readonly embeddings = new Map<string, Float32Array>();
  private readonly embeddingsPath: string;
  private items?: LoadResult<StoreItem[]>;
  private readonly pendingVectors = new Map<string, Float32Array>();
  private pendingCount = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly appDataDirectory: string) {
    fs.mkdirSync(appDataDirectory, { recursive: true });
    this.embeddingsPath = join(appDataDirectory, 'embeddings.jsonl');
    if (!fs.existsSync(this.embeddingsPath)) return;
    const bytes = fs.readFileSync(this.embeddingsPath);
    const end = bytes.lastIndexOf(10) + 1;
    for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (typeof record.id !== 'string' || !Array.isArray(record.vector) ||
          record.vector.length !== 512 || !record.vector.every(Number.isFinite)) {
        throw new Error('잘못된 좌표 기록입니다.');
      }
      this.embeddings.set(record.id, new Float32Array(record.vector));
    }
    if (end !== bytes.length) {
      fs.truncateSync(this.embeddingsPath, end);
      this.warnings.push('저장 중 중단된 마지막 좌표를 제외하고 읽었습니다.');
    }
  }

  private loadJson<T>(name: string, empty: T, valid: (value: unknown) => value is T): LoadResult<T> {
    const path = join(this.appDataDirectory, name);
    const read = (file: string): T => {
      const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!valid(value)) throw new SyntaxError(`잘못된 저장 형식: ${name}`);
      return value;
    };
    try {
      return { data: read(path), warnings: [] };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing && !(error instanceof SyntaxError)) throw error;
      if (missing && !fs.existsSync(`${path}.bak`)) return { data: empty, warnings: [] };
      return {
        data: read(`${path}.bak`),
        warnings: [`${name}을 읽지 못해 이전 판을 읽었습니다.`],
      };
    }
  }

  private saveJson<T>(name: string, data: T, empty: T, valid: (value: unknown) => value is T): void {
    if (!valid(data)) throw new Error(`잘못된 저장 형식: ${name}`);
    const previous = this.loadJson(name, empty, valid);
    const path = join(this.appDataDirectory, name);
    fs.writeFileSync(`${path}.tmp`, JSON.stringify(data), { encoding: 'utf8', flush: true });
    if (fs.existsSync(path) || fs.existsSync(`${path}.bak`)) {
      // Back up the last readable version, never a corrupt current file.
      fs.writeFileSync(`${path}.bak.tmp`, JSON.stringify(previous.data), { encoding: 'utf8', flush: true });
      fs.renameSync(`${path}.bak.tmp`, `${path}.bak`);
    }
    fs.renameSync(`${path}.tmp`, path);
  }

  loadItems(): LoadResult<StoreItem[]> {
    return this.items ??= this.loadJson('items.json', [], isItems);
  }

  /** Analysis is immediately readable, but only a complete batch reaches disk. */
  saveAnalysis(item: StoreItem, vector?: Float32Array): void {
    const items = this.loadItems().data;
    const index = items.findIndex((entry) => entry.id === item.id);
    if (index < 0) return;
    if (vector && (vector.length !== 512 || !vector.every(Number.isFinite))) {
      throw new Error('소리 분석 결과가 올바르지 않습니다.');
    }
    items[index] = item;
    if (vector) this.pendingVectors.set(item.id, vector.slice());
    this.pendingCount++;
    this.flushTimer ??= setTimeout(() => this.flush(), 5_000);
    if (this.pendingCount >= 50) this.flush();
  }

  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.pendingCount) return;
    // A crash here leaves only durations, never vectors whose durations were not saved.
    this.saveJson('items.json', this.loadItems().data, [], isItems);
    if (this.pendingVectors.size) {
      const lines = [...this.pendingVectors].map(([id, vector]) =>
        `${JSON.stringify({ id, vector: Array.from(vector) })}\n`).join('');
      fs.appendFileSync(this.embeddingsPath, lines, { encoding: 'utf8', flush: true });
      for (const [id, vector] of this.pendingVectors) this.embeddings.set(id, vector);
      this.pendingVectors.clear();
    }
    this.pendingCount = 0;
  }

  /** An item with no path leaves this file while its coordinates stay, so its length is kept beside them. */
  saveItems(items: StoreItem[]): void {
    this.flush();
    const durations = this.loadJson<Record<string, number>>('durations.json', {}, isDurations).data;
    const kept = new Set(items.map((item) => item.id));
    const dropped = this.loadItems().data.filter((item) => !kept.has(item.id) && item.duration !== undefined);
    for (const item of dropped) durations[item.id] = item.duration!;
    if (dropped.length) this.saveJson('durations.json', durations, {}, isDurations);
    const saved = items.map((item) =>
      item.duration === undefined && durations[item.id] !== undefined ? { ...item, duration: durations[item.id] } : item);
    this.saveJson('items.json', saved, [], isItems);
    this.items = { data: saved, warnings: [] };
  }

  loadFolders(): LoadResult<StoredFolder[]> {
    return this.loadJson('folders.json', [], isFolders);
  }

  saveFolders(folders: StoredFolder[]): void {
    this.saveJson('folders.json', folders, [], isFolders);
  }

  loadTracking(): LoadResult<FileTracking> {
    return this.loadJson('tracking.json', noTracking, isTracking);
  }

  saveTracking(tracking: FileTracking): void {
    this.saveJson('tracking.json', tracking, noTracking, isTracking);
  }

  loadDecisions(): LoadResult<Decisions> {
    return this.loadJson('decisions.json', {}, isDecisions);
  }

  loadCollections(): LoadResult<CollectionData> {
    return this.loadJson('collections.json', { collections: [], searches: [] }, isCollectionData);
  }

  saveCollections(data: CollectionData): void {
    this.saveJson('collections.json', data, { collections: [], searches: [] }, isCollectionData);
  }

  // Called only for an explicit human decision, not for model suggestions.
  saveDecision(fullSha256: string, value: JsonValue): void {
    if (!sha256.test(fullSha256)) throw new Error('파일 전체 SHA-256이 필요합니다.');
    const decisions = this.loadDecisions().data;
    decisions[fullSha256] = value;
    this.saveJson('decisions.json', decisions, {}, isDecisions);
  }

  removeFolder(folderId: string): void {
    const items = this.loadItems().data
      .map((item) => ({ ...item, paths: item.paths.filter((entry) => entry.folderId !== folderId) }))
      .filter((item) => item.paths.length > 0);
    this.saveItems(items);
  }

  exportDecisionsCsv(): string {
    const path = join(this.appDataDirectory, 'decisions.csv');
    fs.writeFileSync(path, decisionsCsv(this.loadDecisions().data), 'utf8');
    return path;
  }

  appendEmbedding(itemId: string, vector: Float32Array): void {
    if (vector.length !== 512 || !vector.every(Number.isFinite)) {
      throw new Error('소리 분석 결과가 올바르지 않습니다.');
    }
    fs.appendFileSync(this.embeddingsPath,
      `${JSON.stringify({ id: itemId, vector: Array.from(vector) })}\n`,
      { encoding: 'utf8', flush: true });
    this.embeddings.set(itemId, vector.slice());
  }

  getEmbedding(itemId: string): Float32Array | undefined {
    return (this.pendingVectors.get(itemId) ?? this.embeddings.get(itemId))?.slice();
  }
}
