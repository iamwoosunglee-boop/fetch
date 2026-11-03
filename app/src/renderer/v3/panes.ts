import { h } from './dom';

const LIST_MIN = 480;
const KEY_STEP = 16;
const OPENING = { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' };
const CLOSING = { duration: 220, easing: 'cubic-bezier(.4,0,.2,1)' };
const panes = ['menu', 'panel'] as const;
const limits = {
  menu: { min: 180, max: 320, initial: 220, storageKey: 'menuWidth', label: '메뉴 폭' },
  panel: { min: 300, max: 560, initial: 340, storageKey: 'panelWidth', label: 'fetch ai 폭' },
} as const;

type Pane = keyof typeof limits;
type PaneWidths = Readonly<Record<Pane, number>>;
type PanesOpen = Readonly<Record<Pane, boolean>>;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** What a window shows for the saved widths. Saved widths never change here, so a bigger window brings them back. */
export function shownWidths(saved: PaneWidths, open: PanesOpen, windowWidth: number): PaneWidths {
  const panel = open.panel
    ? clamp(saved.panel, limits.panel.min, Math.min(limits.panel.max, windowWidth - (open.menu ? saved.menu : 0) - LIST_MIN)) : 0;
  const menu = open.menu
    ? clamp(saved.menu, limits.menu.min, Math.min(limits.menu.max, windowWidth - panel - LIST_MIN)) : 0;
  return { menu, panel };
}

/** Both panes fit at their saved widths. When they do not, the menu closes first (PRD 7.1 크기 조절). */
export const panesFit = (saved: PaneWidths, windowWidth: number): boolean => saved.menu + saved.panel + LIST_MIN <= windowWidth;

function savedWidth(pane: Pane): number {
  const { min, max, initial, storageKey } = limits[pane];
  const value = Number(localStorage.getItem(storageKey));
  return value >= min && value <= max ? value : initial;
}

/**
 * The drag handles and the widths behind them. The handles sit directly in the body and the widths travel in CSS
 * variables, so a render can never remove a handle in mid-drag.
 */
export function createPanes(open: () => PanesOpen, docked: () => boolean, elements: Readonly<Record<Pane, HTMLElement>>) {
  const saved: Record<Pane, number> = { menu: savedWidth('menu'), panel: savedWidth('panel') };
  let shown: PaneWidths = { menu: 0, panel: 0 };
  let settled = false;
  const showing = { menu: false, panel: false };
  const motions: Partial<Record<Pane, Animation>> = {};
  const calm = matchMedia('(prefers-reduced-motion: reduce)');

  function arrive(pane: Pane): void {
    elements[pane].classList.remove('pane-moving');
    elements[pane].hidden = !showing[pane];
  }

  /** A pane as it is on screen now, a motion under way included. */
  function look(pane: Pane) {
    const element = elements[pane];
    return { width: element.getBoundingClientRect().width, inner: element.clientWidth, opacity: element.hidden ? 0 : Number(getComputedStyle(element).opacity) };
  }

  /** Only opening and closing move: resizing a pane changes its width with no motion on it. */
  function move(pane: Pane, show: boolean, from: ReturnType<typeof look>): void {
    showing[pane] = show;
    const element = elements[pane];
    motions[pane]?.cancel();
    if (calm.matches || !settled) {
      arrive(pane);
      return;
    }
    const interrupted = element.classList.contains('pane-moving');
    element.hidden = false;
    element.classList.add('pane-moving');
    if (show) element.style.setProperty('--pane-width', `${element.clientWidth}px`);
    else if (!interrupted) element.style.setProperty('--pane-width', `${from.inner}px`);
    const to = show ? element.getBoundingClientRect().width : 0;
    const motion = element.animate({ width: [`${from.width}px`, `${to}px`], opacity: [from.opacity, show ? 1 : 0] }, show ? OPENING : CLOSING);
    motion.onfinish = () => arrive(pane);
    motions[pane] = motion;
  }

  for (const pane of panes) elements[pane].hidden = true;

  const largest = (pane: Pane) => Math.max(limits[pane].min, Math.min(limits[pane].max, innerWidth - shown[pane === 'menu' ? 'panel' : 'menu'] - LIST_MIN));

  const edges = { menu: edge('menu'), panel: edge('panel') };

  function layout(): void {
    const wanted = open();
    const turning = panes.filter((pane) => wanted[pane] !== showing[pane]).map((pane) => [pane, look(pane)] as const);
    shown = shownWidths(saved, docked() ? wanted : { menu: false, panel: false }, innerWidth);
    for (const pane of panes) {
      document.documentElement.style.setProperty(`--${pane}`, `${shown[pane]}px`);
      edges[pane].setAttribute('aria-valuenow', String(shown[pane]));
      edges[pane].setAttribute('aria-valuemax', String(largest(pane)));
    }
    for (const [pane, from] of turning) move(pane, wanted[pane], from);
    settled = true;
  }

  function setWidth(pane: Pane, width: number): void {
    saved[pane] = clamp(width, limits[pane].min, largest(pane));
    layout();
  }

  const keep = (pane: Pane) => localStorage.setItem(limits[pane].storageKey, String(saved[pane]));

  function edge(pane: Pane): HTMLDivElement {
    const handle = h('div', {
      class: `pane-edge ${pane}-edge`,
      attrs: { role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': limits[pane].label, 'aria-valuemin': String(limits[pane].min) },
    });
    // The boundary moves with the pointer: right widens the menu and narrows the panel.
    const direction = pane === 'menu' ? 1 : -1;
    handle.addEventListener('pointerdown', (down) => {
      if (down.button !== 0) return;
      handle.setPointerCapture(down.pointerId);
      handle.classList.add('drag');
      const start = shown[pane];
      const move = (event: PointerEvent) => setWidth(pane, start + direction * (event.clientX - down.clientX));
      const end = () => {
        handle.classList.remove('drag');
        handle.removeEventListener('pointermove', move);
        keep(pane);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('lostpointercapture', end, { once: true });
    });
    handle.addEventListener('dblclick', () => {
      saved[pane] = limits[pane].initial;
      layout();
      keep(pane);
    });
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setWidth(pane, shown[pane] + direction * (event.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP));
      keep(pane);
    });
    return handle;
  }

  return { menuEdge: edges.menu, panelEdge: edges.panel, layout, fit: () => panesFit(saved, innerWidth) };
}
