import type { ClassifyDecision, ClassifyOverview } from '../core/classify';
import type { LengthCondition, SearchReference, SearchSound, Vector } from '../core/search';
import type { LibraryPlatform } from './library';
import type { PlanRequest, SearchPlan as RelayPlan } from '../core/plan';
import type { DownloadState } from '../model/download';
import type { CollectionData } from '../core/collections';
import type { PackDetails } from '../core/packs';
import type { PhraseFacts } from '../core/phrase';

export interface NativeAudio {
  log(entry: Record<string, unknown>): void;
  sounds(): Promise<SearchSound[]>;
  read(id: string): Promise<Uint8Array>;
  plan(request: PlanRequest): Promise<RelayPlan>;
  phrase(facts: PhraseFacts): Promise<string>;
  copyReady(id: string): Promise<boolean>;
  saveCopy(id: string, bytes: Uint8Array): Promise<void>;
  /** The icon is a PNG data URL drawn by the screen; the main process checks it. */
  drag(id: string, icon?: string): Promise<void>;
  reveal(id: string): Promise<void>;
}

export interface SearchPlan {
  sentences: string[];
  names: string[];
  fileWords?: readonly string[];
  typicalMaxSeconds?: number | null;
  length?: LengthCondition;
  relative?: 'shorter' | 'longer';
  message: string;
  /** Result count the person asked for ("5개 찾아줘"), 1 to 10; absent when not asked. Never inherited. */
  count?: number;
}

export interface SearchPlanRequest {
  text: string;
  hasReference: boolean;
  referenceDuration?: number;
  previous?: SearchPlan;
}

export interface ReferenceSound extends SearchReference {
  name: string;
  duration: number;
}

export interface PlayOptions {
  /** Seconds into the sound; past its end means the end. */
  offset?: number;
  /** Runs when the sound reaches its end by itself. */
  ended?: () => void;
  /** Reads a sound from outside the library. */
  bytes?: () => Promise<ArrayBuffer>;
}

export interface SearchPlatform {
  log?(entry: Record<string, unknown>): void;
  loadSounds(): Promise<SearchSound[]>;
  prepareQuery?(query: string, signal: AbortSignal): Promise<void>;
  plan(request: SearchPlanRequest, signal: AbortSignal): Promise<SearchPlan>;
  phrase?(facts: PhraseFacts, signal: AbortSignal): Promise<string>;
  embedText(sentences: readonly string[], signal: AbortSignal): Promise<Vector[]>;
  importReference(file: File): Promise<ReferenceSound>;
  /** Abort must cancel an in-flight start as well as active playback. */
  play(sound: SearchSound, signal: AbortSignal, options?: PlayOptions): Promise<void>;
  stop(): void;
  /** Seconds into the sound by the audio clock; undefined until a sound is sounding. */
  position(): number | undefined;
  /** The decoded length of the last sound played. */
  duration(): number | undefined;
  /** 0 to 1; holds for every later sound, wherever it is played from. */
  setGain(value: number): void;
  /** Reports the text model download; undefined means it is over. */
  onDownload?(listener: (state: DownloadState | undefined) => void): () => void;
  prepareDrag?(sound: SearchSound): Promise<void>;
  drag?(sound: SearchSound, icon?: string): Promise<void>;
  reveal?(sound: SearchSound): Promise<void>;
  download?(sound: SearchSound): Promise<void>;
  /**
   * Maps a dropped File back to a library sound id, or undefined for a file outside the library.
   * Both find a file by its whole content; Electron also resolves stored paths and WAV copies made for dragging.
   */
  soundIdForFile?(file: File): Promise<string | undefined>;
}

export interface ClassifyPlatform {
  overview(): Promise<ClassifyOverview>;
  /** Only a person's action reaches this; a saved category is never replaced. */
  decide(fullHashes: string[], decision: ClassifyDecision): Promise<void>;
  /** Saves the decisions CSV: into the app data folder (returns its path), or as a browser download (returns its name). */
  exportCsv(): Promise<string>;
}

export interface CollectionsPlatform {
  load(): Promise<CollectionData>;
  save(data: CollectionData): Promise<void>;
}

export interface PacksPlatform {
  /** Reads every connected pack folder again; call it when folders change, not for every sound. */
  load(): Promise<PackDetails[]>;
  /** Mac only: the pack's license file in Finder. */
  revealLicense?(packId: string): Promise<void>;
}

export interface Platform {
  readonly kind: 'electron' | 'web';
  /** Absent on the web demo, which has no human decisions to keep. */
  readonly classify?: ClassifyPlatform;
  /** Absent on the web demo, which has no app data folder. */
  readonly collections?: CollectionsPlatform;
  readonly connections?: ConnectionPlatform;
  readonly search?: SearchPlatform;
  readonly packs?: PacksPlatform;
  readonly library?: LibraryPlatform;
  readonly nativeAudio?: NativeAudio;
}

export interface LibraryConnection {
  root: string;
  /** Supported audio count, including skipped files. */
  fileCount: number;
  current?: boolean;
  status: 'scanning' | 'indexing' | 'completed' | 'stopped';
  completed: number;
  failed: number;
  /** Files exceeding 100 MB, retained for text search. */
  skipped: number;
  reason?: string;
  /** Subfolders and files the last scan could not read; their saved sounds stay as they are. */
  unreadable?: number;
  /** Why the folder stopped, when the reason needs its own advice. */
  failure?: 'model' | 'folder';
  /** Set while analysis waits for the AI model to arrive. */
  download?: DownloadState;
  /** The last scan could not read the folder, so its sounds stay listed but blocked. */
  offline?: boolean;
  /** Web only: the browser needs the person to allow folder access again (after a reload). */
  needsPermission?: boolean;
}

export interface FileTrackingView {
  moved: { from: string; to: string }[];
  /** Each entry holds every remembered path of one sound. */
  duplicates: string[][];
  missing: { paths: string[]; decision?: string }[];
  questions: { path: string; decision: string }[];
}

export interface FileTrackingPlatform {
  load(): Promise<FileTrackingView>;
  /** Only a person answers this; declining keeps the old decision on the old content. */
  answer(path: string, inherit: boolean): Promise<void>;
}

export interface ConnectionPlatform {
  getFolders(): Promise<LibraryConnection[]>;
  chooseFolder(): Promise<string | null>;
  /** Reject inaccessible new roots without changing existing connections. */
  connectFolder(root: string): Promise<void>;
  /** Preserve human decisions when removing a connection. */
  removeFolder(root: string): Promise<void>;
  rescanFolder(root: string): Promise<void>;
  /**
   * Connects a folder dropped on the window. Call it synchronously inside the drop handler:
   * the browser only exposes dropped items during the event. Resolves false when no folder was dropped.
   */
  connectDrop?(transfer: DataTransfer): Promise<boolean>;
  /** Web only: asks the browser for folder access again; call from a click handler. */
  reauthorize?(root: string): Promise<void>;
  /** Events contain the complete current snapshot. */
  onChange(listener: (folders: LibraryConnection[]) => void): () => void;
  tracking?: FileTrackingPlatform;
}

declare global {
  interface Window {
    fetchApp?: Platform;
  }
}
