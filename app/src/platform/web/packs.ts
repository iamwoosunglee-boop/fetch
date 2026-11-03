import { COVER_LIMIT, coverNames, coverType, licenseName, PACK_JSON_LIMIT, packJsonName, parsePackJson, type PackFacts } from '../../core/packs';
import type { DirectoryHandle, FileHandle } from './fs';

export interface WebPackFiles extends PackFacts {
  cover?: Blob;
  licenseFile?: boolean;
}

async function folderBelow(root: DirectoryHandle, relative: string): Promise<DirectoryHandle> {
  let folder = root;
  for (const part of relative.split('/').filter(Boolean)) {
    if (part === '.' || part === '..') throw new TypeError('A pack folder stays below its connected folder.');
    folder = await folder.getDirectoryHandle(part);
  }
  return folder;
}

const within = async (handle: FileHandle, limit: number) => {
  const file = await handle.getFile();
  return file.size <= limit ? new Uint8Array(await file.arrayBuffer()) : undefined;
};

/** The handle itself is the boundary: it cannot reach outside the folder the person picked. */
export async function readPackFiles(root: DirectoryHandle, relative: string): Promise<WebPackFiles> {
  const found: WebPackFiles = {};
  const files = new Map<string, FileHandle>();
  for await (const entry of (await folderBelow(root, relative)).values()) if (entry.kind === 'file') files.set(entry.name, entry);
  const names = [...files.keys()];
  for (const name of coverNames(names)) {
    const bytes = await within(files.get(name)!, COVER_LIMIT);
    const type = bytes && coverType(bytes);
    if (bytes && type) {
      found.cover = new Blob([bytes as BlobPart], { type });
      break;
    }
  }
  const jsonName = packJsonName(names);
  const json = jsonName && await within(files.get(jsonName)!, PACK_JSON_LIMIT);
  if (json) Object.assign(found, parsePackJson(new TextDecoder().decode(json)));
  if (licenseName(names)) found.licenseFile = true;
  return found;
}
