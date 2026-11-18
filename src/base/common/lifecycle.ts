export interface IDisposable {
  dispose(): void;
}

export function toDisposable(callback: () => void): IDisposable {
  let disposed = false;
  return {
    dispose() {
      if (!disposed) {
        disposed = true;
        callback();
      }
    },
  };
}

export function dispose<T extends IDisposable>(value: T): T;
export function dispose<T extends IDisposable>(value: T | undefined): T | undefined;
export function dispose<T extends IDisposable>(value: Iterable<T>): [];
export function dispose<T extends IDisposable>(value: T | Iterable<T> | undefined): T | [] | undefined {
  if (!value || 'dispose' in value) {
    value?.dispose();
    return value;
  }

  const errors: unknown[] = [];
  for (const item of value) {
    try {
      item.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Errors while disposing resources');
  }
  return [];
}

export function combinedDisposable(...items: IDisposable[]): IDisposable {
  return toDisposable(() => dispose(items));
}

export class DisposableStore implements IDisposable {
  private readonly items = new Set<IDisposable>();
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  add<T extends IDisposable>(item: T): T {
    if (item === this as IDisposable) {
      throw new Error('A DisposableStore cannot contain itself.');
    }
    if (this.disposed) {
      console.warn('DisposableStore is already disposed. The new item is still owned by its caller.');
    } else {
      this.items.add(item);
    }
    return item;
  }

  delete(item: IDisposable): void {
    if (this.items.delete(item)) {
      item.dispose();
    }
  }

  clear(): void {
    const items = [...this.items];
    this.items.clear();
    dispose(items);
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.clear();
    }
  }
}

export abstract class Disposable implements IDisposable {
  static readonly None: IDisposable = Object.freeze({ dispose() {} });
  private readonly store = new DisposableStore();

  protected _register<T extends IDisposable>(item: T): T {
    if (item === this as IDisposable) {
      throw new Error('A Disposable cannot register itself.');
    }
    return this.store.add(item);
  }

  dispose(): void {
    this.store.dispose();
  }
}

export class MutableDisposable<T extends IDisposable> implements IDisposable {
  private current: T | undefined;
  private disposed = false;

  get value(): T | undefined {
    return this.current;
  }

  set value(next: T | undefined) {
    if (this.disposed || next === this.current) {
      return;
    }
    const previous = this.current;
    this.current = next;
    previous?.dispose();
  }

  clear(): void {
    this.value = undefined;
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      const previous = this.current;
      this.current = undefined;
      previous?.dispose();
    }
  }
}
