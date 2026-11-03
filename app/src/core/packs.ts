// What a pack folder says about itself. Display only: nothing here reaches search or ranking.

export interface PackFacts {
  name?: string;
  creator?: string;
  source?: string;
  license?: string;
  tags?: readonly string[];
}

export interface PackDetails extends PackFacts {
  id: string;
  /** A data or blob URL of a checked image. */
  cover?: string;
  licenseFile?: boolean;
}

export const COVER_LIMIT = 5 * 1024 * 1024;
export const PACK_JSON_LIMIT = 64 * 1024;
const LARGEST_SIDE = 4096;
const LARGEST_AREA = 16_000_000;

const coverStems = ['cover', 'folder', 'artwork', 'album'];
const coverTypes = ['png', 'jpg', 'jpeg', 'webp'];

export function coverNames(names: readonly string[]): string[] {
  const rank = (name: string) => {
    const [stem, type, ...rest] = name.toLowerCase().split('.');
    const byStem = coverStems.indexOf(stem);
    const byType = coverTypes.indexOf(type);
    return rest.length || byStem < 0 || byType < 0 ? -1 : byStem * coverTypes.length + byType;
  };
  return names.filter((name) => rank(name) >= 0).sort((a, b) => rank(a) - rank(b));
}

export const packJsonName = (names: readonly string[]) => names.find((name) => name.toLowerCase() === 'pack.json');
export const licenseName = (names: readonly string[]) => names.find((name) => /^licen[cs]e(\.(txt|md|rtf|pdf))?$/i.test(name));

interface ImageSize { type: string; width: number; height: number }

function jpegSize(bytes: Uint8Array, view: DataView): ImageSize | undefined {
  let at = 2;
  while (at + 9 < bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    const startOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (startOfFrame) return { type: 'image/jpeg', height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    at += 2 + view.getUint16(at + 2);
  }
  return undefined;
}

function webpSize(bytes: Uint8Array, view: DataView): ImageSize | undefined {
  const kind = String.fromCharCode(...bytes.subarray(12, 16));
  const type = 'image/webp';
  if (kind === 'VP8X') return { type, width: (view.getUint32(24, true) & 0xffffff) + 1, height: (view.getUint32(27, true) & 0xffffff) + 1 };
  if (kind === 'VP8 ') return { type, width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  if (kind !== 'VP8L') return undefined;
  const bits = view.getUint32(21, true);
  return { type, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

function imageSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 32) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) return { type: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes, view);
  const riff = String.fromCharCode(...bytes.subarray(0, 4)) + String.fromCharCode(...bytes.subarray(8, 12));
  return riff === 'RIFFWEBP' ? webpSize(bytes, view) : undefined;
}

/** The image type by the file's own header; undefined for anything else or for a size that would take too much memory to decode. */
export function coverType(bytes: Uint8Array): string | undefined {
  const size = imageSize(bytes);
  if (!size || size.width > LARGEST_SIDE || size.height > LARGEST_SIDE || size.width * size.height > LARGEST_AREA) return undefined;
  return size.type;
}

const text = (value: unknown, limit: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined);

export function parsePackJson(source: string): PackFacts {
  let value: unknown;
  try { value = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const fields = value as Record<string, unknown>;
  const tags = Array.isArray(fields.tags) ? fields.tags.flatMap((tag) => text(tag, 32) ?? []).slice(0, 8) : [];
  const facts: PackFacts = {
    name: text(fields.name, 80), creator: text(fields.creator, 120), source: text(fields.source, 300), license: text(fields.license, 80),
    ...(tags.length ? { tags } : {}),
  };
  return Object.fromEntries(Object.entries(facts).filter(([, field]) => field !== undefined));
}
