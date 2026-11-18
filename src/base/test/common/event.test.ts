import { expect, test, vi } from 'vitest';
import { Emitter, Event } from '../../common/event.js';
import { DisposableStore, toDisposable } from '../../common/lifecycle.js';
import type { IDisposable } from '../../common/lifecycle.js';

test('skips listeners removed during delivery and defers new subscriptions', () => {
  const emitter = new Emitter<number>();
  const late = vi.fn();
  const removed = vi.fn();
  const disposed = vi.fn();
  emitter.event(() => {
    second.dispose();
    emitter.event(late);
  });
  const second = emitter.event(removed);
  emitter.event(disposed).dispose();

  emitter.fire(1);
  expect(removed).not.toHaveBeenCalled();
  expect(disposed).not.toHaveBeenCalled();
  expect(late).not.toHaveBeenCalled();
  emitter.fire(2);
  expect(late).toHaveBeenCalledExactlyOnceWith(2);

  emitter.dispose();
  emitter.event(removed);
  emitter.fire(3);
  expect(late).toHaveBeenCalledTimes(1);
  expect(removed).not.toHaveBeenCalled();
});

test('reports an exception and still invokes subsequent listeners', () => {
  const emitter = new Emitter<void>();
  const error = new Error('listener failed');
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const listener = vi.fn();
    emitter.event(() => { throw error; });
    emitter.event(listener);
    emitter.fire();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    report.mockRestore();
  }
});

test('a reentrant fire reaches every listener after the value in flight', () => {
  const emitter = new Emitter<number>();
  const seen: string[] = [];
  emitter.event(value => {
    seen.push('first:' + value);
    if (value === 1) {
      emitter.fire(2);
    }
  });
  emitter.event(value => seen.push('second:' + value));

  emitter.fire(1);
  emitter.fire(3);

  expect(seen).toEqual(['first:1', 'second:1', 'first:2', 'second:2', 'first:3', 'second:3']);
});

test('any releases earlier subscriptions when a later source throws', () => {
  const emitter = new Emitter<number>();
  const listener = vi.fn();
  const failure = new Error('subscribe failed');
  const broken: Event<number> = () => { throw failure; };

  expect(() => Event.any(emitter.event, broken)(listener)).toThrow(failure);
  emitter.fire(1);
  expect(listener).not.toHaveBeenCalled();
});

test('maps, filters and combines events and tracks their combined subscription', () => {
  const left = new Emitter<number>();
  const right = new Emitter<number>();
  const store = new DisposableStore();
  const receiver = { values: [] as string[] };
  const source = Event.map(Event.filter(Event.any(left.event, right.event), value => value > 0), String);
  source(function (this: typeof receiver, value) { this.values.push(value); }, receiver, store);

  left.fire(0);
  right.fire(2);
  left.fire(3);
  store.dispose();
  right.fire(4);

  expect(receiver.values).toEqual(['2', '3']);
});

test('once unsubscribes before reentrant delivery and toPromise resolves the first value', async () => {
  const emitter = new Emitter<number>();
  const unsubscribe = vi.fn();
  const tracked: Event<number> = listener => {
    const subscription = emitter.event(listener);
    return toDisposable(() => {
      unsubscribe();
      subscription.dispose();
    });
  };
  // The emitter catches listener exceptions, so record the state instead of asserting inside.
  let unsubscribedBeforeDelivery = false;
  const listener = vi.fn(() => {
    unsubscribedBeforeDelivery = unsubscribe.mock.calls.length === 1;
    emitter.fire(2);
  });
  const pending = Event.toPromise(emitter.event);
  Event.once(tracked)(listener);

  emitter.fire(1);

  expect(listener).toHaveBeenCalledExactlyOnceWith(1);
  expect(unsubscribedBeforeDelivery).toBe(true);
  await expect(pending).resolves.toBe(1);
});

test('once handles an event that delivers before returning its subscription', () => {
  const dispose = vi.fn();
  const immediate: Event<number> = listener => {
    listener(1);
    listener(2);
    return toDisposable(dispose);
  };
  const listener = vi.fn();
  const subscriptions: IDisposable[] = [];
  Event.once(immediate)(listener, undefined, subscriptions);

  expect(listener).toHaveBeenCalledExactlyOnceWith(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  subscriptions[0].dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
});
