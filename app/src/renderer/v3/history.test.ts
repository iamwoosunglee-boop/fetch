import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHistory, searchBatch } from './history';

describe('history', () => {
  const steps = (...names: string[]) => {
    const history = createHistory<string>(names[0], (a, b) => a === b);
    names.slice(1).forEach((name) => history.push(name));
    return history;
  };
  const any = () => true;

  it('goes back and forward through its steps and stops at the ends', () => {
    const history = steps('a', 'b');
    expect(history.canGo(1, any)).toBe(false);
    expect(history.go(-1, any)).toBe('a');
    expect(history.go(-1, any)).toBeUndefined();
    expect(history.canGo(-1, any)).toBe(false);
    expect(history.go(1, any)).toBe('b');
  });

  it('drops the forward steps when something new happens after going back', () => {
    const history = steps('a', 'b', 'c');
    history.go(-1, any);
    history.push('d');
    expect(history.canGo(1, any)).toBe(false);
    expect(history.go(-1, any)).toBe('b');
  });

  it('adds no step for the same place', () => {
    const history = steps('a', 'a');
    expect(history.canGo(-1, any)).toBe(false);
  });

  it('skips entries that are gone, in both directions', () => {
    const history = steps('a', 'gone', 'c');
    const usable = (entry: string) => entry !== 'gone';
    expect(history.go(-1, usable)).toBe('a');
    expect(history.go(1, usable)).toBe('c');
    expect(steps('gone', 'b').canGo(-1, usable)).toBe(false);
  });
});

describe('searchBatch', () => {
  let commit: ReturnType<typeof vi.fn>;
  let batch: ReturnType<typeof searchBatch>;
  beforeEach(() => {
    vi.useFakeTimers();
    commit = vi.fn();
    batch = searchBatch(commit);
  });
  afterEach(() => vi.useRealTimers());

  it('makes one step of a burst of typing, 700ms after the last key', () => {
    batch.typed();
    vi.advanceTimersByTime(699);
    batch.typed();
    vi.advanceTimersByTime(699);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('makes one step for Enter followed by leaving the box', () => {
    batch.typed();
    batch.settle();
    batch.blur();
    vi.advanceTimersByTime(1000);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('waits for a syllable in composition, however long it takes', () => {
    batch.compositionStart();
    batch.typed();
    vi.advanceTimersByTime(5000);
    expect(commit).not.toHaveBeenCalled();
    batch.compositionEnd();
    vi.advanceTimersByTime(700);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('takes the final text when the box loses focus in mid-composition', () => {
    batch.compositionStart();
    batch.typed();
    batch.blur();
    expect(commit).not.toHaveBeenCalled();
    batch.compositionEnd();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('makes no step when nothing was typed', () => {
    batch.blur();
    batch.compositionEnd();
    vi.advanceTimersByTime(1000);
    expect(commit).not.toHaveBeenCalled();
  });
});
