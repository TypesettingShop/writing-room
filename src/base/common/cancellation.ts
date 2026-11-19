import { Emitter, Event } from './event.js';
import { toDisposable } from './lifecycle.js';
import type { IDisposable } from './lifecycle.js';

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<void>;
}

const cancelledEvent: Event<void> = (listener, thisArgs, disposables) => {
  const handle = setTimeout(() => listener.call(thisArgs, undefined), 0);
  const subscription = toDisposable(() => clearTimeout(handle));
  if (Array.isArray(disposables)) {
    disposables.push(subscription);
  } else {
    disposables?.add(subscription);
  }
  return subscription;
};

export namespace CancellationToken {
  export const None: CancellationToken = Object.freeze({ isCancellationRequested: false, onCancellationRequested: Event.None });
  export const Cancelled: CancellationToken = Object.freeze({ isCancellationRequested: true, onCancellationRequested: cancelledEvent });

  export function isCancellationToken(value: unknown): value is CancellationToken {
    const token = value as Partial<CancellationToken> | null;
    return typeof token === 'object' && token !== null
      && typeof token.isCancellationRequested === 'boolean' && typeof token.onCancellationRequested === 'function';
  }
}

export class CancellationTokenSource implements IDisposable {
  private readonly emitter = new Emitter<void>();
  private readonly parentListener?: IDisposable;
  private cancelled = false;
  private disposed = false;
  readonly token: CancellationToken;

  constructor(parent?: CancellationToken) {
    const source = this;
    this.token = Object.freeze({
      get isCancellationRequested() { return source.cancelled; },
      get onCancellationRequested() { return source.cancelled ? cancelledEvent : source.emitter.event; },
    });
    if (parent?.isCancellationRequested) {
      this.cancel();
    } else {
      this.parentListener = parent?.onCancellationRequested(() => this.cancel());
    }
  }

  cancel(): void {
    if (!this.cancelled && !this.disposed) {
      this.cancelled = true;
      this.parentListener?.dispose();
      this.emitter.fire();
      this.emitter.dispose();
    }
  }

  dispose(cancel = false): void {
    if (cancel) {
      this.cancel();
    }
    this.disposed = true;
    this.parentListener?.dispose();
    this.emitter.dispose();
  }
}
