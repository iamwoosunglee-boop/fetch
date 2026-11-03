import { embeddingEligible, isSupportedAudio, type Fingerprint } from '../../core/files';

/** The parts of the File System Access API this build uses; TypeScript's DOM lib lacks some of them. */
export interface FileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}
export interface DirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  values(): AsyncIterable<FileHandle | DirectoryHandle>;
  getDirectoryHandle(name: string): Promise<DirectoryHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
  isSameEntry(other: DirectoryHandle): Promise<boolean>;
  queryPermission?(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'read' }): Promise<PermissionState>;
}

export interface FoundFile {
  path: string;
  handle: FileHandle;
}

/** Throws when the root itself cannot be read; unreadable subfolders are only counted. */
export async function walkDirectory(root: DirectoryHandle): Promise<{ files: FoundFile[]; unreadable: number }> {
  const files: FoundFile[] = [];
  let unreadable = 0;
  async function walk(folder: DirectoryHandle, prefix: string, top: boolean): Promise<void> {
    const children: (FileHandle | DirectoryHandle)[] = [];
    try {
      for await (const entry of folder.values()) children.push(entry);
    } catch (error) {
      if (top) throw error;
      unreadable++;
      return;
    }
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${prefix}${entry.name}`;
      if (entry.kind === 'directory') {
        if (!entry.name.startsWith('.')) await walk(entry, `${path}/`, false);
      } else if (isSupportedAudio(path)) {
        files.push({ path, handle: entry });
      }
    }
  }
  await walk(root, '', true);
  return { files, unreadable };
}

export async function resolveFile(root: DirectoryHandle, relativePath: string): Promise<File> {
  const parts = relativePath.split('/');
  let folder = root;
  for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
  return (await folder.getFileHandle(parts.at(-1)!)).getFile();
}

const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (n) => n.toString(16).padStart(2, '0')).join('');
export const sha256 = async (bytes: BufferSource) => hex(await crypto.subtle.digest('SHA-256', bytes));

/**
 * Same windows as src/main/scan.ts: SHA-256 of the first and last 64 KiB, then the whole file.
 * Files above 100 MB get no analysis, so their identity stays size plus edges instead of a full read.
 */
export async function fingerprintFile(file: Blob): Promise<Fingerprint> {
  const windowSize = Math.min(65_536, file.size);
  const head = new Uint8Array(await file.slice(0, windowSize).arrayBuffer());
  const tail = new Uint8Array(await file.slice(file.size - windowSize).arrayBuffer());
  const edges = new Uint8Array(windowSize * 2);
  edges.set(head);
  edges.set(tail, windowSize);
  const edgeSha256 = await sha256(edges);
  if (!embeddingEligible(file.size)) return { edgeSha256, sha256: `edge:${file.size}:${edgeSha256}` };
  return { edgeSha256, sha256: await sha256(await file.arrayBuffer()) };
}
