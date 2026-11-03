import { h, imeKey } from './dom';
import { icon } from './icons';
import { app } from './state';

const WINDOW_EDGE = 12;
const SUBMENU_GAP = 4;
const ANCHOR_GAP = 4;
const SUBMENU_DELAY_MS = 200;
const SAFE_PATH_MS = 300;

let open: HTMLElement | undefined;
let sub: HTMLElement | undefined;
let subOwner: HTMLElement | undefined;
let opener: HTMLElement | undefined;
let lastAnchor = new DOMRect();
let leavingTimer: ReturnType<typeof setTimeout> | undefined;
let stopWatching = () => {};

function closeSub(): void {
  clearTimeout(leavingTimer);
  leavingTimer = undefined;
  stopWatching();
  sub?.remove();
  sub = undefined;
  subOwner?.setAttribute('aria-expanded', 'false');
  subOwner?.classList.remove('hot');
  subOwner = undefined;
}

export function closeMenu(): void {
  closeSub();
  open?.remove();
  open = undefined;
}

const host = () => document.querySelector<HTMLElement>('#app')!;

function fit(menu: HTMLElement, left: number, top: number): void {
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(WINDOW_EDGE, Math.min(left, innerWidth - WINDOW_EDGE - width))}px`;
  menu.style.top = `${Math.max(4, Math.min(top, innerHeight - 4 - height))}px`;
}

export function popover(anchor: HTMLElement, className: string, items: HTMLElement[]): void {
  closeMenu();
  const menu = h('div', { class: className, attrs: { role: 'menu' } }, ...items);
  // A redraw may have replaced the row under an open menu; the next menu then opens where that one did.
  if (anchor.isConnected) lastAnchor = anchor.getBoundingClientRect();
  opener = anchor;
  const box = lastAnchor;
  menu.style.position = 'fixed';
  host().append(menu);
  const { width, height } = menu.getBoundingClientRect();
  const roomBelow = innerHeight - box.bottom - 2 * ANCHOR_GAP;
  const roomAbove = box.top - 2 * ANCHOR_GAP;
  const below = height <= roomBelow || roomBelow >= roomAbove;
  // In a short window the list scrolls inside the menu, and the chip that opened it stays in sight.
  const shown = Math.min(height, below ? roomBelow : roomAbove);
  menu.style.maxHeight = `${shown}px`;
  fit(menu, className === 'menu' ? box.right - width : box.left, below ? box.bottom + ANCHOR_GAP : box.top - shown - ANCHOR_GAP);
  open = menu;
}

export const menuItem = (label: Node | string, onClick: () => void, trailing?: Node, leading?: Node, full?: string) =>
  h('button', {
    type: 'button',
    attrs: { role: 'menuitem', 'aria-label': full },
    on: {
      click: (event) => { event.stopPropagation(); closeMenu(); app.focusList(); onClick(); },
      pointerenter: (event) => { if (sub && leavingTimer === undefined && !sub.contains(event.currentTarget as Node)) closeSub(); },
    },
  }, leading ?? h('span'), typeof label === 'string' ? h('span', { text: label }) : label, trailing ?? h('span'));

function openSub(owner: HTMLElement, items: HTMLElement[]): void {
  if (subOwner === owner) return;
  closeSub();
  const menu = h('div', { class: 'menu sub', attrs: { role: 'menu' } }, ...items);
  menu.style.position = 'fixed';
  host().append(menu);
  const parent = owner.parentElement!.getBoundingClientRect();
  const width = menu.getBoundingClientRect().width;
  const roomOnRight = parent.right + SUBMENU_GAP + width <= innerWidth - WINDOW_EDGE;
  fit(menu, roomOnRight ? parent.right + SUBMENU_GAP : parent.left - SUBMENU_GAP - width, owner.getBoundingClientRect().top - 5);
  sub = menu;
  subOwner = owner;
  owner.setAttribute('aria-expanded', 'true');
  owner.classList.add('hot');
}

const sign = (a: DOMPoint, b: DOMPoint, c: DOMPoint) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);

function inTriangle(point: DOMPoint, a: DOMPoint, b: DOMPoint, c: DOMPoint): boolean {
  const signs = [sign(point, a, b), sign(point, b, c), sign(point, c, a)];
  return signs.every((value) => value >= 0) || signs.every((value) => value <= 0);
}

/** Leaving the item for the submenu crosses its neighbours, so the submenu waits while the pointer stays on the way. */
function watchPath(from: DOMPoint): void {
  stopWatching();
  const menu = sub!;
  const box = menu.getBoundingClientRect();
  const parent = subOwner!.parentElement!.getBoundingClientRect();
  const edge = box.left >= parent.right ? box.left : box.right;
  const watch = (event: PointerEvent) => {
    const point = new DOMPoint(event.clientX, event.clientY);
    const arrived = point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
    if (arrived) { clearTimeout(leavingTimer); leavingTimer = undefined; stopWatching(); }
    else if (!inTriangle(point, from, new DOMPoint(edge, box.top), new DOMPoint(edge, box.bottom))) closeSub();
  };
  document.addEventListener('pointermove', watch);
  stopWatching = () => document.removeEventListener('pointermove', watch);
  leavingTimer = setTimeout(closeSub, SAFE_PATH_MS);
}

export function submenuItem(label: string, leading: Node, items: () => HTMLElement[]): HTMLElement {
  let hover: ReturnType<typeof setTimeout> | undefined;
  const item = h('button', {
    type: 'button',
    attrs: { role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    on: {
      click: (event) => { event.stopPropagation(); clearTimeout(hover); openSub(item, items()); },
      pointerenter: () => {
        clearTimeout(leavingTimer);
        leavingTimer = undefined;
        stopWatching();
        hover = setTimeout(() => openSub(item, items()), SUBMENU_DELAY_MS);
      },
      pointerleave: (event) => {
        clearTimeout(hover);
        if (sub) watchPath(new DOMPoint(event.clientX, event.clientY));
      },
    },
  }, leading, h('span', { text: label }), icon('right', 13));
  return item;
}

function focusItem(menu: HTMLElement, step: 1 | -1): void {
  const items = Array.from(menu.querySelectorAll<HTMLElement>(':scope > button:not(:disabled)'));
  const at = items.indexOf(document.activeElement as HTMLElement);
  items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length]?.focus();
}

function closeTop(): void {
  if (sub) {
    const owner = subOwner;
    closeSub();
    owner?.focus();
    return;
  }
  closeMenu();
  if (opener?.isConnected) opener.focus(); else app.focusList();
}

/** An open menu takes these keys before the list and playback ever see them. */
document.addEventListener('keydown', (event) => {
  if (!open || imeKey(event)) return;
  const target = event.target as HTMLElement;
  const typing = target.matches('input, textarea');
  if (!['Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key) || (typing && event.key !== 'Escape')) return;
  event.preventDefault();
  event.stopPropagation();
  const menu = sub ?? open;
  const item = menu.contains(target) && target.matches('[role=menuitem]') ? target : undefined;
  if (event.key === 'Escape') closeTop();
  else if (event.key === 'ArrowDown') focusItem(menu, 1);
  else if (event.key === 'ArrowUp') focusItem(menu, -1);
  else if (event.key === 'ArrowLeft') { if (sub) closeTop(); }
  else if (item && (event.key !== 'ArrowRight' || item.hasAttribute('aria-haspopup'))) {
    const opensSubmenu = item.hasAttribute('aria-haspopup');
    item.click();
    if (opensSubmenu && sub) focusItem(sub, 1);
  }
}, true);

document.addEventListener('pointerdown', (event) => {
  const target = event.target as Node;
  if (open && !open.contains(target) && !sub?.contains(target)) closeMenu();
});

// A menu belongs to the row that opened it: it goes when that row moves away, not when rows arrive and the view holds still.
document.addEventListener('scroll', () => {
  if (open && opener?.isConnected && opener.getBoundingClientRect().top !== lastAnchor.top) closeMenu();
}, true);
