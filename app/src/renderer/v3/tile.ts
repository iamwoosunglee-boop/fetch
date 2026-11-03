import { h } from './dom';
import type { PackInfo } from './library';

/** A pack's picture wherever one is shown: its cover, or its two letters on its colour. */
export function tile(pack: PackInfo | undefined, open?: (pack: PackInfo) => void): HTMLElement {
  const style = `--tile:var(--tile-${pack?.tone ?? 0})`;
  const picture = pack?.cover ? h('img', { attrs: { src: pack.cover, alt: '', draggable: 'false' } }) : pack?.code ?? '';
  if (!pack || !open) return h('span', { class: 'tile', style, attrs: pack ? { role: 'img', 'aria-label': pack.full } : {} }, picture);
  return h('button', {
    class: 'tile', type: 'button', style, attrs: { 'aria-label': pack.full },
    on: { click: (event) => { event.stopPropagation(); open(pack); } },
  }, picture);
}
