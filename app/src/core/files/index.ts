import { categoryLabel } from '../classify/labels';

export interface FileMetadata {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface Fingerprint {
  edgeSha256: string;
  sha256: string;
}

export interface ScannedFile extends FileMetadata, Fingerprint {}

export interface FileItem extends Fingerprint {
  id: string;
  size: number;
  paths: FileMetadata[];
  embeddingEligible: boolean;
}

export function isSupportedAudio(path: string): boolean {
  // AppleDouble companions (._name.wav) hold macOS metadata, not audio.
  return /\.(wav|mp3|ogg|flac)$/i.test(path) && !/(^|[\\/])\._[^\\/]*$/.test(path);
}

// MB is decimal; 64 KiB fingerprint windows are 65,536 bytes.
export function embeddingEligible(size: number): boolean {
  return size <= 100_000_000;
}

export function isUnchanged(current: FileMetadata, previous: FileMetadata): boolean {
  return current.path === previous.path && current.size === previous.size && current.mtimeMs === previous.mtimeMs;
}

export function reconcileFiles(files: readonly ScannedFile[], previous: readonly FileItem[] = []): {
  items: FileItem[];
  missing: FileItem[];
} {
  const candidates = new Map<string, FileItem[]>();
  for (const item of previous) {
    const key = `${item.size}:${item.edgeSha256}`;
    const group = candidates.get(key) ?? [];
    group.push(item);
    candidates.set(key, group);
  }
  const current = new Map<string, FileItem>();
  for (const file of files) {
    const key = `${file.size}:${file.edgeSha256}`;
    // Edge matches only narrow the candidates. Full hashes establish identity.
    const match = candidates.get(key)?.find((item) => item.sha256 === file.sha256);
    const id = match?.id ?? file.sha256;
    const metadata = { path: file.path, size: file.size, mtimeMs: file.mtimeMs };
    const existing = current.get(id);
    if (existing) {
      existing.paths.push(metadata);
    } else {
      current.set(id, {
        id, size: file.size, edgeSha256: file.edgeSha256, sha256: file.sha256,
        paths: [metadata], embeddingEligible: embeddingEligible(file.size),
      });
    }
  }
  return {
    items: [...current.values()],
    missing: previous.filter((item) => !current.has(item.id)),
  };
}

export interface TrackedPath {
  folderId: string;
  path: string;
}

export interface MovedFile {
  folderId: string;
  from: string;
  to: string;
}

export interface MissingFile {
  fullSha256: string;
  paths: TrackedPath[];
}

/** An open question. It only exists until a person answers it. */
export interface ChangedFile extends TrackedPath {
  fromSha256: string;
  toSha256: string;
}

export interface FileTracking {
  moved: MovedFile[];
  missing: MissingFile[];
  changed: ChangedFile[];
}

const movedLimit = 100;

export function detectChanges(previous: readonly FileItem[], items: readonly FileItem[]): {
  moved: { from: string; to: string }[];
  changed: { path: string; fromSha256: string; toSha256: string }[];
} {
  const before = new Map(previous.map((item) => [item.id, item]));
  const moved: { from: string; to: string }[] = [];
  const movedFrom = new Set<string>();
  for (const item of items) {
    const old = before.get(item.id);
    if (!old) continue;
    const now = new Set(item.paths.map((entry) => entry.path));
    const then = new Set(old.paths.map((entry) => entry.path));
    const removed = old.paths.filter((entry) => !now.has(entry.path));
    const added = item.paths.filter((entry) => !then.has(entry.path));
    for (let i = 0; i < Math.min(removed.length, added.length); i++) {
      moved.push({ from: removed[i].path, to: added[i].path });
      movedFrom.add(removed[i].path);
    }
  }
  const owner = new Map(previous.flatMap((item) => item.paths.map((entry) => [entry.path, item.sha256] as const)));
  // Content already known to this folder at another path is a swap, not an edit.
  const changed = items.filter((item) => !before.has(item.id)).flatMap((item) => item.paths.flatMap((entry) => {
    const fromSha256 = owner.get(entry.path);
    return fromSha256 && !movedFrom.has(entry.path)
      ? [{ path: entry.path, fromSha256, toSha256: item.sha256 }] : [];
  }));
  return { moved, changed };
}

export function updateTracking(tracking: FileTracking, scan: {
  root: string;
  previous: readonly FileItem[];
  items: readonly FileItem[];
  missing: readonly FileItem[];
  /** Whole-file hashes that still have a path in any connected folder. */
  live: ReadonlySet<string>;
  hasDecision(sha256: string): boolean;
}): FileTracking {
  const { moved, changed } = detectChanges(scan.previous, scan.items);
  const found = new Map(scan.items.map((item) => [item.sha256, item]));
  const returned: MovedFile[] = tracking.missing.flatMap((record) => {
    const from = record.paths[0].path;
    const to = found.get(record.fullSha256)?.paths[0].path;
    return to && to !== from ? [{ folderId: scan.root, from, to }] : [];
  });
  const replaced = new Set(changed.map((entry) => entry.fromSha256));
  const missing = new Map(tracking.missing
    .filter((record) => !scan.live.has(record.fullSha256))
    .map((record) => [record.fullSha256, record]));
  for (const item of scan.missing) {
    // Nothing to keep: the path still works and no decision is attached to the old content.
    if (scan.live.has(item.sha256) || (replaced.has(item.sha256) && !scan.hasDecision(item.sha256))) continue;
    missing.set(item.sha256, {
      fullSha256: item.sha256,
      paths: item.paths.map((entry) => ({ folderId: scan.root, path: entry.path })),
    });
  }
  const current = new Map(scan.items.flatMap((item) => item.paths.map((entry) => [entry.path, item.sha256] as const)));
  const open = new Map(tracking.changed.map((entry) => {
    const toSha256 = entry.folderId === scan.root ? current.get(entry.path) ?? entry.toSha256 : entry.toSha256;
    return [entry.path, { ...entry, toSha256 }] as const;
  }));
  for (const entry of changed) {
    if (!open.has(entry.path) && scan.hasDecision(entry.fromSha256)) {
      open.set(entry.path, { ...entry, folderId: scan.root });
    }
  }
  return {
    moved: [...moved.map((entry) => ({ ...entry, folderId: scan.root })), ...returned, ...tracking.moved].slice(0, movedLimit),
    missing: [...missing.values()],
    changed: [...open.values()].filter((entry) => entry.fromSha256 !== entry.toSha256),
  };
}

/** The app stores only the two decision shapes of core/classify. */
export function describeDecision(value: unknown): string {
  const decision = value as { category?: unknown; excluded?: unknown } | null;
  if (typeof decision?.category === 'string') return categoryLabel(decision.category);
  return decision?.excluded === true ? '묶음에서 뺌' : '알 수 없는 결정';
}

/** The decisions CSV of the Mac app and the web (PRD 7.5): one row per whole-file hash, the decision as JSON. */
export function decisionsCsv(decisions: Readonly<Record<string, unknown>>): string {
  const rows = Object.entries(decisions).map(([hash, value]) => `${hash},"${JSON.stringify(value).replaceAll('"', '""')}"`);
  return ['fullSha256,decision', ...rows, ''].join('\r\n');
}

/** Row waveform length; the list draws one bar per value. */
export const PEAK_COUNT = 48;

/**
 * The loudest absolute sample of each of `count` equal slices, scaled so the loudest slice is 100.
 * Integers keep items.json small; silence and empty audio give all zeros.
 */
export function computePeaks(channels: readonly ArrayLike<number>[], count = PEAK_COUNT): number[] {
  const length = Math.max(0, ...channels.map((channel) => channel.length));
  const peaks = Array.from({ length: count }, (_, slice) => {
    let peak = 0;
    const end = Math.floor(((slice + 1) * length) / count);
    for (let i = Math.floor((slice * length) / count); i < end; i++) {
      for (const channel of channels) peak = Math.max(peak, Math.abs(channel[i] ?? 0));
    }
    return peak;
  });
  const loudest = Math.max(...peaks);
  return peaks.map((peak) => (loudest > 0 ? Math.round((peak / loudest) * 100) : 0));
}
