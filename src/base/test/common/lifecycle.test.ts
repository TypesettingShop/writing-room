import { expect, test, vi } from 'vitest';
import { combinedDisposable, Disposable, DisposableStore, dispose, MutableDisposable, toDisposable } from '../../common/lifecycle.js';

test('a disposed store warns and leaves later items for the caller to dispose', () => {
  const first = { dispose: vi.fn() };
  const late = { dispose: vi.fn() };
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const store = new DisposableStore();
    expect(store.add(first)).toBe(first);
    store.add(first);
    store.dispose();
    expect(store.add(late)).toBe(late);
    store.clear();
    store.dispose();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(late.dispose).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

test('deleting an item from a store disposes it once and keeps the others', () => {
  const store = new DisposableStore();
  const removed = store.add({ dispose: vi.fn() });
  const kept = store.add({ dispose: vi.fn() });

  store.delete(removed);
  expect(removed.dispose).toHaveBeenCalledTimes(1);
  store.dispose();
  expect(removed.dispose).toHaveBeenCalledTimes(1);
  expect(kept.dispose).toHaveBeenCalledTimes(1);
});

test('disposing an iterable attempts all disposals and reports the failures', () => {
  const first = new Error('first');
  const second = new Error('second');
  const last = { dispose: vi.fn() };
  const group = combinedDisposable(
    toDisposable(() => { throw first; }),
    toDisposable(() => { throw second; }),
    last,
  );

  expect(() => group.dispose()).toThrow(AggregateError);
  expect(last.dispose).toHaveBeenCalledTimes(1);
  expect(() => group.dispose()).not.toThrow();
  expect(last.dispose).toHaveBeenCalledTimes(1);
  expect(dispose(last)).toBe(last);
  expect(dispose([])).toEqual([]);
});

test('a mutable disposable releases its previous value and clears its final value once', () => {
  const mutable = new MutableDisposable();
  const first = { dispose: vi.fn() };
  const second = { dispose: vi.fn() };

  mutable.value = first;
  mutable.value = first;
  expect(first.dispose).not.toHaveBeenCalled();
  mutable.value = second;
  expect(first.dispose).toHaveBeenCalledTimes(1);
  expect(mutable.value).toBe(second);
  mutable.dispose();
  mutable.clear();
  expect(mutable.value).toBeUndefined();
  expect(second.dispose).toHaveBeenCalledTimes(1);

  const late = { dispose: vi.fn() };
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mutable.value = late;
    expect(warning).toHaveBeenCalledTimes(1);
    expect(mutable.value).toBeUndefined();
    expect(late.dispose).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

test('a disposable releases all registered resources', () => {
  const cleanup = vi.fn();
  class Owner extends Disposable {
    readonly resource = this._register(toDisposable(cleanup));
  }
  const owner = new Owner();

  owner.dispose();
  owner.resource.dispose();
  expect(cleanup).toHaveBeenCalledTimes(1);
});
