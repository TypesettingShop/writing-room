import { CancellationToken } from './cancellation.js';
import { CancellationError } from './errors.js';
import type { IDisposable } from './lifecycle.js';

export function raceCancellation<T>(promise: PromiseLike<T>, token: CancellationToken): Promise<T | undefined>;
export function raceCancellation<T>(promise: PromiseLike<T>, token: CancellationToken, defaultValue: T): Promise<T>;
export function raceCancellation<T>(promise: PromiseLike<T>, token: CancellationToken, defaultValue?: T): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (token.isCancellationRequested) {
      resolve(defaultValue);
    }
    let listener: IDisposable | undefined;
    if (!token.isCancellationRequested) {
      listener = token.onCancellationRequested(() => {
        listener?.dispose();
        resolve(defaultValue);
      });
    }
    Promise.resolve(promise).then(value => {
      listener?.dispose();
      resolve(value);
    }, error => {
      listener?.dispose();
      reject(error);
    });
  });
}

export class Sequencer {
  private tail: Promise<unknown> = Promise.resolve();

  queue<T>(task: () => PromiseLike<T> | T): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next;
    return next;
  }
}

export class Throttler implements IDisposable {
  private active?: Promise<unknown>;
  private queued?: { factory: () => PromiseLike<unknown> | unknown; result: Promise<unknown> };
  private disposed = false;

  /** Runs the active task and only the most recent task waiting behind it. */
  queue<T>(factory: () => PromiseLike<T> | T): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new CancellationError());
    }
    if (this.active) {
      if (this.queued) {
        this.queued.factory = factory;
        return this.queued.result as Promise<T>;
      }
      const start = () => {
        const queued = this.queued!;
        this.queued = undefined;
        return this.queue(queued.factory);
      };
      const result = this.active.then(start, start);
      this.queued = { factory, result };
      return result as Promise<T>;
    }

    const active = Promise.resolve().then(factory);
    this.active = active;
    const finish = () => { this.active = undefined; };
    void active.then(finish, finish);
    return active;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class RunOnceScheduler implements IDisposable {
  private handle?: ReturnType<typeof setTimeout>;
  private runner: (() => void) | undefined;

  constructor(runner: () => void, private readonly delay: number) {
    this.runner = runner;
  }

  schedule(delay = this.delay): void {
    this.cancel();
    if (this.runner) {
      this.handle = setTimeout(() => {
        this.handle = undefined;
        this.runner?.();
      }, delay);
    }
  }

  isScheduled(): boolean { return this.handle !== undefined; }
  cancel(): void {
    clearTimeout(this.handle);
    this.handle = undefined;
  }
  dispose(): void {
    this.cancel();
    this.runner = undefined;
  }
}

export class DeferredPromise<T> {
  readonly p: Promise<T>;
  private resolve!: (value: T) => void;
  private reject!: (error: unknown) => void;
  private outcome?: { readonly value: T } | { readonly error: unknown };

  constructor() {
    this.p = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  get isSettled(): boolean { return this.outcome !== undefined; }
  get isResolved(): boolean { return this.outcome !== undefined && 'value' in this.outcome; }
  get isRejected(): boolean { return this.outcome !== undefined && 'error' in this.outcome; }
  get value(): T | undefined { return this.outcome && 'value' in this.outcome ? this.outcome.value : undefined; }

  async complete(value: T): Promise<void> {
    if (!this.outcome) {
      this.outcome = { value };
      this.resolve(value);
    }
  }

  async error(error: unknown): Promise<void> {
    if (!this.outcome) {
      this.outcome = { error };
      this.reject(error);
    }
  }

  cancel(): Promise<void> { return this.error(new CancellationError()); }
}
