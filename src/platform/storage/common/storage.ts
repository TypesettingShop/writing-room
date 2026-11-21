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

  /**
   * Return a snapshot of this tab's cached keys for the given scope, without their scope prefixes.
   * Use the `storeImmediately` snapshot for decisions that must see persisted values across tabs.
   */
  keys(scope: StorageScope): string[];

  store(key: string, value: StorageValue, scope: StorageScope, target: StorageTarget): void;
  /**
   * Commit an explicit text save. A transform receives the last persisted value and every persisted address;
   * returning `undefined` removes the key, and throwing leaves the stored value as it was.
   */
  storeImmediately(
    key: string, value: string | ((stored: string | undefined, snapshot: ReadonlyMap<string, string>) => string | undefined), scope: StorageScope, target: StorageTarget,
  ): void;
  remove(key: string, scope: StorageScope): void;
  flush(reason?: WillSaveStateReason): Promise<void>;

  /**
   * True once this tab's values live only in memory: the persistent backend could not be opened, a write to it
   * failed, or another tab changed it in a way this code cannot follow. It stays true until the service closes.
   */
  readonly usesMemory: boolean;
  /**
   * Read the value the persistent backend holds for a key now, even before another tab's storage event arrives.
   * The cache takes that value and listeners hear an `external` change when it differs. Nothing is written, and a
   * value this tab queued with `store` or `remove` is the answer. Once `usesMemory` is true, or after the service
   * closed, this tab's value is the answer. Throws when the persistent backend cannot be read.
   */
  getPersisted(key: string, scope: StorageScope): string | undefined;
}

export function storageKey(scope: StorageScope, key: string): string {
  return scope + ':' + key;
}

const storageScopes = new Map(
  Object.values(StorageScope)
    .filter((value): value is StorageScope => typeof value === 'number')
    .map(scope => [String(scope), scope]),
);

export function parseStorageKey(namespacedKey: string): { scope: StorageScope; key: string } | undefined {
  const separator = namespacedKey.indexOf(':');
  const scope = separator === -1 ? undefined : storageScopes.get(namespacedKey.slice(0, separator));
  return scope === undefined ? undefined : { scope, key: namespacedKey.slice(separator + 1) };
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
    // The subscription lives in `disposables` and also in any store the caller passes.
    return (listener, thisArgs, sink) => disposables.add(changes(listener, thisArgs, sink));
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
    // Number() reads back every String(number) that store() writes, fractions and exponents included.
    return value === undefined ? fallbackValue : Number(value);
  }

  getObject<T extends object>(key: string, scope: StorageScope, fallbackValue: T): T;
  getObject<T extends object>(key: string, scope: StorageScope, fallbackValue?: T): T | undefined;
  getObject<T extends object>(key: string, scope: StorageScope, fallbackValue?: T): T | undefined {
    const namespacedKey = storageKey(scope, key);
    const value = this.storage.get(namespacedKey);
    if (value !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = undefined;
      }
      // Valid JSON such as `null` or `5` is not an object either, so it gets the fallback too.
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as T;
      }
      if (!this.reportedInvalidObjects.has(namespacedKey)) {
        this.reportedInvalidObjects.add(namespacedKey);
        console.warn('Could not parse workbench storage value as an object.', { scope, key });
      }
    }
    return fallbackValue;
  }

  keys(scope: StorageScope): string[] {
    const keys: string[] = [];
    for (const namespacedKey of this.storage.keys()) {
      const address = parseStorageKey(namespacedKey);
      if (address?.scope === scope) {
        keys.push(address.key);
      }
    }
    return keys;
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

  storeImmediately(
    key: string, value: string | ((stored: string | undefined, snapshot: ReadonlyMap<string, string>) => string | undefined), scope: StorageScope, target: StorageTarget,
  ): void {
    if (this.disposed) {
      throw new Error('Workbench storage is closed.');
    }
    if (this.storage.setImmediately(storageKey(scope, key), value)) {
      this.valueChanges.fire({ scope, key, target });
    }
  }

  remove(key: string, scope: StorageScope): void {
    if (!this.disposed && this.storage.set(storageKey(scope, key), undefined)) {
      this.valueChanges.fire({ scope, key, target: undefined });
    }
  }

  get usesMemory(): boolean {
    return this.storage.usesMemory;
  }

  getPersisted(key: string, scope: StorageScope): string | undefined {
    const namespacedKey = storageKey(scope, key);
    if (this.disposed) {
      return this.storage.get(namespacedKey);
    }
    const { value, changed } = this.storage.getPersisted(namespacedKey);
    if (changed) {
      this.valueChanges.fire({ scope, key, target: undefined, external: true });
    }
    return value;
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
