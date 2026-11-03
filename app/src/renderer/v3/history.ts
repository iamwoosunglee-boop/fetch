export interface History<T> {
  current(): T;
  replace(entry: T): void;
  /** A new step; a step that changes nothing only updates the current one. Forward history goes. */
  push(entry: T): void;
  canGo(step: -1 | 1, usable: (entry: T) => boolean): boolean;
  go(step: -1 | 1, usable: (entry: T) => boolean): T | undefined;
}

export function createHistory<T>(first: T, same: (a: T, b: T) => boolean): History<T> {
  let entries = [first];
  let cursor = 0;
  const target = (step: -1 | 1, usable: (entry: T) => boolean) => {
    for (let index = cursor + step; index >= 0 && index < entries.length; index += step) {
      if (usable(entries[index])) return index;
    }
    return -1;
  };
  return {
    current: () => entries[cursor],
    replace(entry) { entries[cursor] = entry; },
    push(entry) {
      if (same(entries[cursor], entry)) { entries[cursor] = entry; return; }
      entries = [...entries.slice(0, cursor + 1), entry];
      cursor++;
    },
    canGo: (step, usable) => target(step, usable) >= 0,
    go(step, usable) {
      const index = target(step, usable);
      if (index < 0) return undefined;
      cursor = index;
      return entries[index];
    },
  };
}

const SEARCH_PAUSE_MS = 700;

/** Groups typing into one step: a pause, Enter or leaving the box ends it; a syllable still being composed never does. */
export function searchBatch(commit: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;
  let leftWhileComposing = false;
  let typed = false;
  const settle = () => {
    clearTimeout(timer);
    if (!typed) return;
    typed = false;
    commit();
  };
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(settle, SEARCH_PAUSE_MS);
  };
  return {
    settle,
    typed() {
      typed = true;
      if (!composing) wait();
    },
    compositionStart() {
      composing = true;
      clearTimeout(timer);
    },
    compositionEnd() {
      composing = false;
      if (leftWhileComposing) {
        leftWhileComposing = false;
        settle();
      } else if (typed) wait();
    },
    blur() {
      if (composing) leftWhileComposing = true;
      else settle();
    },
  };
}
