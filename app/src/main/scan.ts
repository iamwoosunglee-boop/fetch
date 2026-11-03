import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  embeddingEligible, isSupportedAudio, isUnchanged, reconcileFiles,
  type FileItem, type FileMetadata, type Fingerprint, type ScannedFile,
} from '../core/files';

export interface ScanResult {
  status: 'completed' | 'stopped';
  items: FileItem[];
  missing: FileItem[];
  fileCount: number;
  oversizedCount: number;
  /** Subfolders and files below root that could not be read this time. */
  unreadableCount?: number;
  reason?: string;
}

// Volume bookkeeping that macOS keeps at a drive root. They hold no library sounds.
const systemFolders = new Set([
  '.Trashes', '.Spotlight-V100', '.fseventsd', '.DocumentRevisions-V100', '.TemporaryItems',
]);

export async function fingerprintFile(filePath: string): Promise<Fingerprint> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const windowSize = Math.min(65_536, size);
    const edge = createHash('sha256');
    for (const position of [0, Math.max(0, size - windowSize)]) {
      const buffer = Buffer.alloc(windowSize);
      let offset = 0;
      while (offset < windowSize) {
        const { bytesRead } = await handle.read(buffer, offset, windowSize - offset, position + offset);
        if (bytesRead === 0) throw new Error('File changed while reading its fingerprint');
        offset += bytesRead;
      }
      edge.update(buffer);
    }
    const whole = createHash('sha256');
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      whole.update(chunk);
    }
    return { edgeSha256: edge.digest('hex'), sha256: whole.digest('hex') };
  } finally {
    await handle.close();
  }
}

export async function scanLibrary(root: string, previous: FileItem[] = []): Promise<ScanResult> {
  const directory = path.resolve(root);
  try {
    const metadata: FileMetadata[] = [];
    const unreadable: string[] = [];
    async function walk(folder: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(folder, { withFileTypes: true });
      } catch (error) {
        if (folder === directory) throw error;
        unreadable.push(folder);
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const filePath = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (!systemFolders.has(entry.name)) await walk(filePath);
        } else if (entry.isFile() && isSupportedAudio(entry.name)) {
          try {
            const stat = await fs.stat(filePath);
            metadata.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
          } catch {
            unreadable.push(filePath);
          }
        }
      }
    }
    await walk(directory);
    const byPath = new Map<string, ScannedFile>();
    for (const item of previous) {
      for (const entry of item.paths) {
        byPath.set(entry.path, { ...entry, edgeSha256: item.edgeSha256, sha256: item.sha256 });
      }
    }
    const files: ScannedFile[] = [];
    // Sequential reads keep disk and CPU load low, including on external drives.
    for (const entry of metadata) {
      const cached = byPath.get(entry.path);
      if (cached && isUnchanged(entry, cached)) {
        files.push(cached);
        continue;
      }
      try {
        files.push({ ...entry, ...await fingerprintFile(entry.path) });
      } catch {
        unreadable.push(entry.path);
      }
    }
    // A drive pulled mid-walk looks like unreadable subfolders; it must stop the scan instead.
    if (unreadable.length) await fs.readdir(directory);
    // Not read this time is not gone: saved entries below these paths stay as they are.
    for (const [file, cached] of byPath) {
      if (unreadable.some((entry) => file === entry || file.startsWith(entry + path.sep))) files.push(cached);
    }
    return {
      status: 'completed',
      ...reconcileFiles(files, previous),
      fileCount: files.length,
      oversizedCount: files.filter((file) => !embeddingEligible(file.size)).length,
      unreadableCount: unreadable.length,
    };
  } catch {
    // Do not commit a partial scan or mark offline files as missing.
    return {
      status: 'stopped', items: previous, missing: [],
      fileCount: previous.reduce((count, item) => count + item.paths.length, 0),
      oversizedCount: previous.reduce((count, item) => count + (item.embeddingEligible ? 0 : item.paths.length), 0),
      reason: `폴더를 읽을 수 없어 확인을 멈췄습니다: ${directory}`,
    };
  }
}
