import type { PackInfo } from './library';

const SIZE = 64;
const CORNER = 8;
const covers = new Map<string, HTMLImageElement>();
const drawn = new Map<string, HTMLCanvasElement>();

/** Decodes a cover once; a header can look right on a file that will never draw, and then the tile stands in. */
export async function coverDecodes(url: string): Promise<boolean> {
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    covers.set(url, image);
    return true;
  } catch {
    return false;
  }
}

function paintTile(context: CanvasRenderingContext2D, pack: PackInfo | undefined): void {
  const styles = getComputedStyle(document.documentElement);
  context.fillStyle = styles.getPropertyValue(`--tile-${pack?.tone ?? 0}`);
  context.fillRect(0, 0, SIZE, SIZE);
  context.fillStyle = styles.getPropertyValue('--fg');
  context.font = `600 24px ${styles.getPropertyValue('--font')}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(pack?.code ?? '', SIZE / 2, SIZE / 2 + 1);
}

/** Synchronous, because dragstart cannot wait: the picture is either drawn already or drawn from what is at hand. */
export function dragPicture(pack: PackInfo | undefined): HTMLCanvasElement {
  const key = `${pack?.id}\0${pack?.cover}`;
  const ready = drawn.get(key);
  if (ready) return ready;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d')!;
  context.beginPath();
  context.roundRect(0, 0, SIZE, SIZE, CORNER);
  context.clip();
  const cover = pack?.cover ? covers.get(pack.cover) : undefined;
  if (cover) context.drawImage(cover, 0, 0, SIZE, SIZE);
  else paintTile(context, pack);
  drawn.set(key, canvas);
  return canvas;
}
