import { Emitter } from '../../../base/common/event.js';
import { dispose, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';

export class Disposable {
  readonly #entry: IDisposable;

  constructor(callOnDispose: () => unknown) {
    this.#entry = toDisposable(callOnDispose);
  }

  static from(...disposables: IDisposable[]): Disposable {
    return new Disposable(() => dispose(disposables));
  }

  dispose(): void {
    this.#entry.dispose();
  }
}

export class EventEmitter<T> {
  readonly #emitter = new Emitter<T>();
  event = this.#emitter.event;

  fire(data: T): void {
    this.#emitter.fire(data);
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}
