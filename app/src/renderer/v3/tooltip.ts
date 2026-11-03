import { h } from './dom';

const WINDOW_EDGE = 12;
const GAP = 7;
const DELAY_MS = 1_500;
/** A cursor that leaves one tooltip and reaches the next within this time gets it at once. */
const WARM_MS = 300;
const CUT_NAMES = '.fname, .nav-c span, .pack';
// Buttons whose icon says what they do, and tiles, stay quiet: a passing cursor should not light up the list.
const NAMED = '.ib[aria-label]:not(.row .play, .crow .play, .ref-play), .mid[aria-label]';

const tip = h('div', { class: 'tip', attrs: { role: 'tooltip', hidden: true } });
let anchor: Element | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastShown = -Infinity;

function hide(): void {
  clearTimeout(timer);
  if (tip.classList.contains('on')) lastShown = performance.now();
  anchor = undefined;
  tip.classList.remove('on');
  tip.hidden = true;
}

function show(target: Element, text: string): void {
  tip.textContent = text;
  tip.hidden = false;
  const box = target.getBoundingClientRect();
  const size = tip.getBoundingClientRect();
  const fromStart = target.matches(`.tile, .pack, .mid, ${CUT_NAMES}`);
  const centre = fromStart ? box.left + 18 : box.left + box.width / 2;
  const left = Math.max(WINDOW_EDGE, Math.min(fromStart ? box.left : centre - size.width / 2, innerWidth - WINDOW_EDGE - size.width));
  const above = box.top - GAP - size.height >= 4;
  tip.style.transform = `translate(${left}px, ${above ? box.top - GAP - size.height : box.bottom + GAP}px)`;
  tip.style.setProperty('--tail', `${Math.max(10, Math.min(centre - left, size.width - 10))}px`);
  tip.classList.toggle('down', !above);
  tip.classList.add('on');
}

function enter(target: Element, atOnce = false): void {
  const named = target.closest(NAMED);
  const label = named?.getAttribute('aria-label');
  const name = target.closest(CUT_NAMES);
  if ((named ?? name) === anchor && anchor) return;
  hide();
  const found = named && label ? named : name && name.scrollWidth > name.clientWidth ? name : undefined;
  if (!found) return;
  anchor = found;
  const text = label ?? found.getAttribute('aria-label') ?? found.textContent ?? '';
  if (atOnce || performance.now() - lastShown < WARM_MS) show(found, text);
  else timer = setTimeout(() => { if (found.isConnected) show(found, text); }, DELAY_MS);
}

export function mountTooltips(host: HTMLElement): void {
  host.append(tip);
  document.addEventListener('pointerover', (event) => enter(event.target as Element));
  document.documentElement.addEventListener('pointerleave', hide);
  document.addEventListener('focusin', (event) => { if ((event.target as Element).matches(':focus-visible')) enter(event.target as Element, true); });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide);
  document.addEventListener('dragstart', hide);
  document.addEventListener('scroll', hide, true);
}

/** A redraw can take the anchor away while the pointer rests; no other event would say so. */
export function dropOrphanTooltip(): void {
  if (anchor && !anchor.isConnected) hide();
}
