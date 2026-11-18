import { combinedDisposable, Disposable, dispose, toDisposable } from './lifecycle.js';
import type { DisposableStore, IDisposable } from './lifecycle.js';

type DisposableSink = DisposableStore | IDisposable[];

export interface Event<T> {
  (listener: (value: T) => void, thisArgs?: unknown, disposables?: DisposableSink): IDisposable;
}

function track(subscription: IDisposable, sink?: DisposableSink): IDisposable {
  if (Array.isArray(sink)) {
    sink.push(subscription);
  } else {
    sink?.add(subscription);
  }
  return subscription;
}

export namespace Event {
  export const None: Event<never> = () => Disposable.None;

  export function once<T>(source: Event<T>): Event<T> {
    return (listener, thisArgs, disposables) => {
      let fired = false;
      let subscription: IDisposable | undefined;
      subscription = source(value => {
        if (fired) {
          return;
        }
        fired = true;
        subscription?.dispose();
        listener.call(thisArgs, value);
      });
      // An event can deliver a value during subscription itself.
      if (fired) {
        subscription.dispose();
      }
      return track(subscription, disposables);
    };
  }

  export function map<T, U>(source: Event<T>, transform: (value: T) => U): Event<U> {
    return (listener, thisArgs, disposables) => source(
      value => listener.call(thisArgs, transform(value)), undefined, disposables,
    );
  }

  export function filter<T, U extends T>(source: Event<T>, predicate: (value: T) => value is U): Event<U>;
  export function filter<T>(source: Event<T>, predicate: (value: T) => boolean): Event<T>;
  export function filter<T>(source: Event<T>, predicate: (value: T) => boolean): Event<T> {
    return (listener, thisArgs, disposables) => source(value => {
      if (predicate(value)) {
        listener.call(thisArgs, value);
      }
    }, undefined, disposables);
  }

  export function any<T>(...sources: Event<T>[]): Event<T> {
    return (listener, thisArgs, disposables) => {
      const subscriptions: IDisposable[] = [];
      try {
        for (const source of sources) {
          subscriptions.push(source(listener, thisArgs));
        }
      } catch (error) {
        dispose(subscriptions);
        throw error;
      }
      return track(combinedDisposable(...subscriptions), disposables);
    };
  }

  export function toPromise<T>(source: Event<T>): Promise<T> {
    return new Promise(resolve => once(source)(resolve));
  }
}

interface Delivery<T> {
  readonly value: T;
  readonly listeners: readonly ((value: T) => void)[];
  next: number;
}

export class Emitter<T> implements IDisposable {
  private readonly listeners = new Set<(value: T) => void>();
  private delivery: Delivery<T> | undefined;
  private disposed = false;

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    if (this.disposed) {
      return Disposable.None;
    }
    const callback = (value: T) => listener.call(thisArgs, value);
    this.listeners.add(callback);
    return track(toDisposable(() => this.listeners.delete(callback)), disposables);
  };

  fire(value: T): void {
    // A reentrant fire first finishes the value in flight so every listener sees values in order.
    if (this.delivery) {
      this.deliver(this.delivery);
    }
    if (this.listeners.size === 0) {
      return;
    }
    // Listeners added during delivery wait for the next fire; deliver() skips ones removed meanwhile.
    const delivery: Delivery<T> = { value, listeners: [...this.listeners], next: 0 };
    this.delivery = delivery;
    try {
      this.deliver(delivery);
    } finally {
      this.delivery = undefined;
    }
  }

  private deliver(delivery: Delivery<T>): void {
    while (delivery.next < delivery.listeners.length) {
      const listener = delivery.listeners[delivery.next++];
      if (this.listeners.has(listener)) {
        try {
          listener(delivery.value);
        } catch (error) {
          console.error(error);
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
