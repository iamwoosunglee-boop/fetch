const paths = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.2-4.2"/>',
  chev: '<path d="M7 10l5 5 5-5"/>',
  chevL: '<path d="M15 5.5L8.5 12l6.5 6.5"/>',
  chevR: '<path d="M9 5.5l6.5 6.5L9 18.5"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  heart: '<path d="M12 19.5s-7-4.3-8.6-8.5C2.3 8.1 4.2 5 7.3 5c1.9 0 3.3 1.1 4.7 2.8C13.4 6.1 14.8 5 16.7 5c3.1 0 5 3.1 3.9 6-1.6 4.2-8.6 8.5-8.6 8.5z"/>',
  heartOn: '<path d="M12 19.5s-7-4.3-8.6-8.5C2.3 8.1 4.2 5 7.3 5c1.9 0 3.3 1.1 4.7 2.8C13.4 6.1 14.8 5 16.7 5c3.1 0 5 3.1 3.9 6-1.6 4.2-8.6 8.5-8.6 8.5z" fill="currentColor"/>',
  sort: '<path d="M8 5v14M5 16l3 3 3-3M16 19V5M13 8l3-3 3 3"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5.5v13M16 5.5v13" stroke-width="3"/>',
  prev: '<path d="M6.5 6v12"/><path d="M18.5 6l-9 6 9 6z" fill="currentColor" stroke="none"/>',
  next: '<path d="M17.5 6v12"/><path d="M5.5 6l9 6-9 6z" fill="currentColor" stroke="none"/>',
  vol: '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z" fill="currentColor"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  more: '<g fill="currentColor" stroke="none"><circle cx="12" cy="6" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18" r="1.6"/></g>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  stack: '<path d="M4 8.5L12 4.5l8 4-8 4zM4 12.5l8 4 8-4M4 16.5l8 4 8-4"/>',
  enter: '<path d="M20 5v6a4 4 0 0 1-4 4H5"/><path d="M9.5 10.5L5 15l4.5 4.5"/>',
  folder: '<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.4l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  packs: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  all: '<path d="M5 10v4M9 6v12M13 9v6M17 5v14M21 10v4"/>',
  dl: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  reply: '<path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 6 6"/>',
  alert: '<path d="M12 5l8.5 14.5h-17zM12 10.5v4M12 17v.3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  unlink: '<path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71M8 2v3M2 8h3M16 19v3M19 16h3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  ring: '<circle cx="12" cy="12" r="7" opacity=".3"/><path d="M12 5a7 7 0 0 1 7 7"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
} as const;

export type IconName = keyof typeof paths;

/** The held ball of fetch ai, drawn apart for each size: path, then the ball's x, y and radius. */
const markShapes = {
  16: ['M5 15V7C5 3.3 7.1 1.25 10.4 1.25C12.4 1.25 14 2.2 15 4L13.3 5C12.6 3.9 11.7 3.25 10.4 3.25C8.2 3.25 7 4.6 7 7V15ZM2.5 8H8V10H2.5Z', 11, 7, 2.25],
  20: ['M6 19V8.75C6 4.1 8.6 1.5 12.75 1.5C15.25 1.5 17.25 2.7 18.5 5L16.35 6.25C15.5 4.85 14.35 4 12.75 4C10 4 8.5 5.75 8.5 8.75V19ZM3 10H10V12.5H3Z', 13.5, 8.75, 2.75],
  32: ['M10 30V14C10 6.6 14.2 2.5 20.8 2.5C24.8 2.5 28 4.4 30 8L26.7 10C25.3 7.8 23.4 6.25 20.8 6.25C16.4 6.25 14 9.2 14 14V30ZM5 16H16V20H5Z', 22, 14, 4.5],
} as const;

export function mark(size: keyof typeof markShapes, className = ''): SVGSVGElement {
  const [shape, x, y, radius] = markShapes[size];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `mk ${className}`.trim());
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<path d="${shape}"/><circle class="ball" cx="${x}" cy="${y}" r="${radius}"/>`;
  return svg;
}

export function icon(name: IconName, size = 16, className = 'i'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths[name];
  return svg;
}
