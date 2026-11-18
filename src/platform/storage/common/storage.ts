import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { InMemoryStorageDatabase, Storage } from '../../../base/parts/storage/common/storage.js';
import type { IStorageDatabase } from '../../../base/parts/storage/common/storage.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IStorageService = createDecorator<IStorageService>('storageService');

export enum StorageScope {
  APPLICATION = -1,
  PROFILE = 0,
  WORKSPACE = 1,
}

export enum StorageTarget {
  USER,
  MACHINE,
}

export enum WillSaveStateReason {
  NONE,
  SHUTDOWN,
}

export type StorageValue = string | boolean | number | object | undefined | null;

export interface IStorageValueChangeEvent {
  readonly scope: StorageScope;
  readonly key: string;
  readonly target: StorageTarget | undefined;
  readonly external?: boolean;
}

export interface IWillSaveStateEvent {
  readonly reason: WillSaveStateReason;
}

export interface IStorageService {
  readonly _serviceBrand: undefined;
  readonly onWillSaveState: Event<IWillSaveStateEvent>;
  onDidChangeValue(scope: StorageScope, key: string | undefined, disposables: DisposableStore): Event<IStorageValueChangeEvent>;

  get(key: string, scope: StorageScope, fallbackValue: string): string;
  get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined;
  getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
  getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined;
  getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
  getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined;
  getObject<T extends object>(key: string, scope: StorageScope, fallbackValue: T): T;
  getObject<T extends object>(key: string, scope: StorageScope, fallbackValue?: T): T | undefined;

  store(key: string, value: StorageValue, scope: StorageScope, target: StorageTarget): void;
  remove(key: string, scope: StorageScope): void;
  flush(reason?: WillSaveStateReason): Promise<void>;
}

export function storageKey(scope: StorageScope, key: string): string {
  return scope + ':' + key;
}

export function parseStorageKey(namespacedKey: string): { scope: StorageScope; key: string } | undefined {
  const separator = namespacedKey.indexOf(':');
  if (separator === -1) {
    return;
  }
  const namespace = namespacedKey.slice(0, separator);
  switch (namespace) {
    case '-1':
    case '0':
    case '1':
      return { scope: Number(namespace) as StorageScope, key: namespacedKey.slice(separator + 1) };
  }
}

export abstract class AbstractStorageService implements IStorageService, IDisposable {
  declare readonly _serviceBrand: undefined;
  protected readonly disposables = new DisposableStore();
  private readonly valueChanges = this.disposables.add(new Emitter<IStorageValueChangeEvent>());
  private readonly willSaveState = this.disposables.add(new Emitter<IWillSaveStateEvent>());
  private readonly reportedInvalidObjects = new Set<string>();
  private flushing = false;
  private disposed = false;

  readonly onWillSaveState = this.willSaveState.event;
  protected readonly storage: Storage;

  constructor(database: IStorageDatabase) {
    this.storage = new Storage(database);
  }

  onDidChangeValue(scope: StorageScope, key: string | undefined, disposables: DisposableStore): Event<IStorageValueChangeEvent> {
    const changes = Event.filter(this.valueChanges.event, event =>
      event.scope === scope && (key === undefined || event.key === key),
    );
    return (listener, thisArgs) => changes(listener, thisArgs, disposables);
  }

  get(key: string, scope: StorageScope, fallbackValue: string): string;
  get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined;
  get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined {
    return this.storage.get(storageKey(scope, key)) ?? fallbackValue;
  }

  getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
  getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined;
  getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
    const value = this.get(key, scope);
    return value === undefined ? fallbackValue : value === 'true';
  }

  getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
  getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined;
  getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined {
    const value = this.get(key, scope);
    return value === undefined ? fallbackValue : Number.parseInt(value, 10);
  }

  getObject<T extends object>(key: string, scope: StorageScope, fallbackValue: T): T;
  getObject<T extends object>(key: string, scope: StorageScope, fallbackValue?: T): T | undefined;
  getObject<T extends object>(key: string, scope: StorageScope, fallbackValue?: T): T | undefined {
    const namespacedKey = storageKey(scope, key);
    const value = this.storage.get(namespacedKey);
    if (value !== undefined) {
      try {
        return JSON.parse(value) as T;
      } catch {
        if (!this.reportedInvalidObjects.has(namespacedKey)) {
          this.reportedInvalidObjects.add(namespacedKey);
          console.warn('Could not parse workbench storage value.', { scope, key });
        }
      }
    }
    return fallbackValue;
  }

  store(key: string, value: StorageValue, scope: StorageScope, target: StorageTarget): void {
    if (this.disposed) {
      return;
    }
    if (value === undefined || value === null) {
      this.remove(key, scope);
      return;
    }
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (this.storage.set(storageKey(scope, key), text)) {
      this.valueChanges.fire({ scope, key, target });
    }
  }

  remove(key: string, scope: StorageScope): void {
    if (!this.disposed && this.storage.set(storageKey(scope, key), undefined)) {
      this.valueChanges.fire({ scope, key, target: undefined });
    }
  }

  protected acceptExternalValue(namespacedKey: string, value: string | undefined): void {
    const address = parseStorageKey(namespacedKey);
    if (address && this.storage.acceptExternal(namespacedKey, value)) {
      this.valueChanges.fire({ ...address, target: undefined, external: true });
    }
  }

  async flush(reason = WillSaveStateReason.NONE): Promise<void> {
    if (this.disposed || this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      this.willSaveState.fire({ reason });
      this.storage.flush();
    } finally {
      this.flushing = false;
    }
  }

  protected startIdleSave(whenIdle: (save: () => void) => IDisposable): void {
    let idle: IDisposable | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        idle = whenIdle(() => {
          idle = undefined;
          void this.flush();
          if (!this.disposed) {
            schedule();
          }
        });
      }, 60_000);
    };
    schedule();
    this.disposables.add(toDisposable(() => {
      clearTimeout(timer);
      idle?.dispose();
    }));
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.storage.close();
      this.disposables.dispose();
    }
  }
}

export class InMemoryStorageService extends AbstractStorageService {
  constructor(database: IStorageDatabase = new InMemoryStorageDatabase()) {
    super(database);
  }
}
