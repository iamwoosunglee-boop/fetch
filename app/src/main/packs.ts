import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COVER_LIMIT, coverNames, coverType, licenseName, PACK_JSON_LIMIT, packJsonName, parsePackJson, type PackDetails } from '../core/packs';

const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
};

/** The real path of a file, or nothing when a link leads it out of the connected folder. */
async function realInside(root: string, file: string): Promise<string | undefined> {
  const real = await fs.realpath(file).catch(() => undefined);
  return real && isInside(root, real) ? real : undefined;
}

async function readUpTo(file: string, limit: number): Promise<Buffer | undefined> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) return undefined;
    const bytes = Buffer.allocUnsafe(info.size);
    const { bytesRead } = await handle.read(bytes, 0, info.size, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function packFolder(root: string, id: string) {
  const rootPath = await fs.realpath(root).catch(() => undefined);
  const folder = rootPath && await realInside(rootPath, id);
  if (!rootPath || !folder) return undefined;
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  return { names, fileIn: (name: string) => realInside(rootPath, path.join(folder, name)) };
}

export async function readPackDetails(root: string, id: string): Promise<PackDetails> {
  const details: PackDetails = { id };
  const pack = await packFolder(root, id);
  if (!pack) return details;
  for (const name of coverNames(pack.names)) {
    const file = await pack.fileIn(name);
    const bytes = file && await readUpTo(file, COVER_LIMIT);
    const type = bytes && coverType(bytes);
    if (bytes && type) {
      details.cover = `data:${type};base64,${bytes.toString('base64')}`;
      break;
    }
  }
  const jsonName = packJsonName(pack.names);
  const jsonFile = jsonName && await pack.fileIn(jsonName);
  const json = jsonFile && await readUpTo(jsonFile, PACK_JSON_LIMIT);
  if (json) Object.assign(details, parsePackJson(json.toString('utf8')));
  if (await findLicense(root, id)) details.licenseFile = true;
  return details;
}

export async function findLicense(root: string, id: string): Promise<string | undefined> {
  const pack = await packFolder(root, id);
  const name = pack && licenseName(pack.names);
  return name ? pack.fileIn(name) : undefined;
}
