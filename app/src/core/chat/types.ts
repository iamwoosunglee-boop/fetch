// Contract between the chat logic (src/core/chat) and the chat panel (src/renderer).
// The chat logic owns tabs, messages and the per-answer conditions; the panel only renders this state
// and calls the store methods. PRD v3 7.3 and doc/ui/ux-definition.md section 0 items 22, 23, 30, 33-35.
import type { LengthCondition, RankedSound, SearchSound, Vector } from '../search';
import type { SearchTuning } from '../search/scoring';
import type { SearchPlatform } from '../../platform/types';
import type { autoConditions } from './index';

/** The example sound ("본보기"). A library sound carries soundId and its pack ids so other packs come first. */
export interface ChatReference {
  /** Set when the reference is a sound from the library. */
  soundId?: string;
  /** File name shown in the pinned bar and the message bubble. */
  name: string;
  duration: number;
  embedding: Vector;
  fullHash?: string;
  /** Every pack holding the reference; omit for a file from outside the library. */
  packIds?: readonly string[];
  /** Pack used for the reference's tile, when it is a library sound. */
  packId?: string;
}

/** Conditions Haiku picked by itself (PRD 7.3 자동 조건); see autoConditions in core/chat. */
export type AutoConditions = ReturnType<typeof autoConditions>;

/** Conditions in force after an answer. Stored on every answer so a reply continues from that point. */
export interface ChatConditions {
  /** English sentences from Haiku; empty when Haiku was not called or failed. */
  sentences: string[];
  /** Never pinned; the group leaves with the last sentence chip of its request. */
  auto: AutoConditions;
  length?: LengthCondition;
  relative?: 'shorter' | 'longer';
  reference?: ChatReference;
}

export type ChatErrorCode =
  | 'offline' | 'timeout' | 'format' | 'server' | 'limit' | 'dailyLimit' | 'model' | 'notAnalyzed';

export interface ChatUserMessage {
  kind: 'user';
  id: string;
  /** May be empty when only a reference was dropped. */
  text: string;
  reference?: ChatReference;
  /** Present when the person replied to an earlier answer or to one result sound. */
  replyTo?: { answerId: string; soundId?: string; label: string };
}

export interface ChatAnswer {
  kind: 'answer';
  id: string;
  /** pending: waiting for Haiku or the text model; results may already hold file-name matches. */
  status: 'pending' | 'done' | 'failed';
  /** Final sentence; empty while the search or phrase call is pending. */
  line: string;
  planMessage?: string;
  reason?: string;
  waiting?: string;
  writing: boolean;
  canRetry: boolean;
  /** Only length-removal and zero-result notices. */
  notes: string[];
  /** Analysed and total sound counts while analysis runs, shown after the sentence. */
  scope?: string;
  /** Said under the results once the tab has nothing left to show for this request. */
  closing?: string;
  /** Results of this answer, in display order; grows by 3 on every "더 보기". */
  results: RankedSound[];
  /** Indexes in results where a "더 보기" batch starts; the panel draws a thin line above those rows. */
  cuts: number[];
  /** True when "더 보기" can still add unseen sounds. */
  canMore: boolean;
  /** True when a length condition removed sounds; the panel shows "길이 조건 해제". */
  canRelaxLength: boolean;
  /** Set for failures that the line explains (the line already holds the sentence). */
  error?: ChatErrorCode;
  conditions: ChatConditions;
}

export type ChatMessage = ChatUserMessage | ChatAnswer;

export interface ChatChip {
  /** Stable within a tab; pass it back to removeChip. */
  id: string;
  kind: 'reference' | 'sentence' | 'word' | 'length';
  label: string;
}

export interface ChatTab {
  id: string;
  /** Short title for the tab: the first request, or the reference name. "새 대화" before the first send. */
  title: string;
  messages: readonly ChatMessage[];
  /** Pinned bar under the tabs: the reference and condition chips that the next request inherits. */
  pinned: { reference?: ChatReference; chips: readonly ChatChip[] };
  /** True while an answer in this tab is pending. */
  busy: boolean;
}

export interface ChatState {
  tabs: readonly ChatTab[];
  activeTabId: string;
  /** False while the library has no sounds; the panel's button stays disabled (UX 0-37). */
  available: boolean;
}

export interface ChatStoreOptions {
  /** plan, embedText and importReference come from here. */
  platform: SearchPlatform;
  /** Current library snapshot; read on every search, so analysis progress is picked up. */
  sounds: () => readonly SearchSound[];
  /** Scoring constants for reproduction runs; the app uses SEARCH_TUNING. */
  tuning?: SearchTuning;
  /** True while connected folders are still being checked or analysed. */
  analysing?: () => boolean;
  reducedMotion?: () => boolean;
  /** The renderer's displayed pack name, including any shortened label. */
  packName?: (sound: SearchSound) => string;
  /** Deterministic ids in tests. */
  newId?: () => string;
}

export interface ChatStore {
  getState(): ChatState;
  /** Called after every change with the new state. Returns an unsubscribe function. */
  subscribe(listener: (state: ChatState) => void): () => void;
  /** Opens an empty tab, makes it active and returns its id. */
  newTab(): string;
  /** Closing the last tab leaves one empty tab. */
  closeTab(tabId: string): void;
  selectTab(tabId: string): void;
  /**
   * Sends a request in the active tab. Text may be empty when a reference is given.
   * replyTo.answerId continues from that answer's conditions; replyTo.soundId makes that result the reference.
   * Resolves when the answer is final (done or failed).
   */
  send(input: { text: string; reference?: ChatReference; replyTo?: { answerId: string; soundId?: string } }): Promise<void>;
  /** "더 보기": appends up to 3 sounds not yet shown in the tab to that answer. */
  more(answerId: string): Promise<void>;
  retry(answerId: string): Promise<void>;
  /** "길이 조건 해제": repeats that answer without its length condition. */
  relaxLength(answerId: string): Promise<void>;
  /** Removes a pinned chip from what the next request inherits; it does not search again. */
  removeChip(chipId: string): void;
  /** Re-reads availability after the library changed. */
  refresh(): void;
  dispose(): void;
}
