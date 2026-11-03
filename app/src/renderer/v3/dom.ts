type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  title?: string;
  type?: 'button' | 'submit';
  style?: string;
  attrs?: Record<string, string | boolean | undefined>;
  dataset?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.text !== undefined) element.textContent = props.text;
  if (props.title) element.title = props.title;
  if (props.type) element.setAttribute('type', props.type);
  if (props.style) element.setAttribute('style', props.style);
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === false || value === undefined) continue;
    element.setAttribute(name, value === true ? '' : value);
  }
  for (const [name, value] of Object.entries(props.dataset ?? {})) element.dataset[name] = value;
  for (const [name, listener] of Object.entries(props.on ?? {})) element.addEventListener(name, listener as EventListener);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === 'number' ? String(child) : child);
  }
  return element;
}

export function iconButton(icon: Node, label: string, onClick: (event: MouseEvent) => void, className = 'ib'): HTMLButtonElement {
  return h('button', { class: className, type: 'button', attrs: { 'aria-label': label }, on: { click: onClick } }, icon);
}

/** A path that shrinks before its last folder, so the folder name stays readable; the whole path is its tooltip. */
export function midPath(path: string, whole: string): HTMLSpanElement {
  const last = path.search(/[^\\/]*$/);
  return h('span', { class: 'mid', attrs: { 'aria-label': whole } },
    h('span', { class: 'mid-a', text: path.slice(0, last) }), h('span', { class: 'mid-b', text: path.slice(last) }));
}

/** True while an input method owns the key. Code 229 also covers the keydown that ends a composition. */
export const imeKey = (event: KeyboardEvent): boolean => event.isComposing || event.keyCode === 229;

export function clear(element: Element): void {
  element.replaceChildren();
}
