import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IStorageDatabase, IStorageUpdate } from '../../../../base/parts/storage/common/storage.js';
import { AbstractStorageService, parseStorageKey, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';

export const STORAGE_PREFIX = 'writing-room:storage:';
export const STORAGE_VERSION_KEY = STORAGE_PREFIX + 'version';
export const STORAGE_SCHEMA_VERSION = 1;

// Draft keys have the scope prefix produced by storageKey, with no browser prefix.
type StorageMigration = (draft: Map<string, string>) => undefined;
const migrations = new Map<number, StorageMigration>();

export function registerStorageMigration(fromVersion: number, migrate: StorageMigration): void {
  if (!Number.isSafeInteger(fromVersion) || fromVersion < 0 || migrations.has(fromVersion)) {
    throw new Error(`Invalid or duplicate storage migration from version ${fromVersion}.`);
  }
  migrations.set(fromVersion, migrate);
}

class LocalStorageDatabase implements IStorageDatabase {
  private area: globalThis.Storage | undefined;
  private readonly versionText: string;

  constructor(private readonly open: () => globalThis.Storage, private readonly schemaVersion: number) {
    this.versionText = String(schemaVersion);
  }

  getItems(): Map<string, string> {
    const area = this.area = this.open();
    const marker = area.getItem(STORAGE_VERSION_KEY);
    const version = marker === null ? 0 : Number(marker);
    if (marker !== null && (!Number.isSafeInteger(version) || version < 0 || String(version) !== marker)) {
      throw new Error('Invalid workbench storage schema version.');
    }
    if (version > this.schemaVersion) {
      throw new Error(`Workbench storage schema ${version} is newer than ${this.schemaVersion}.`);
    }

    const keys = this.prefixedKeys(area);
    const items = this.readItems(area, keys);
    if (version < this.schemaVersion && (marker !== null || keys.length !== 0)) {
      return this.migrate(area, marker, version, items);
    }
    return items;
  }

  private prefixedKeys(area: globalThis.Storage): string[] {
    const keys: string[] = [];
    for (let i = 0; i < area.length; i++) {
      const key = area.key(i);
      if (key?.startsWith(STORAGE_PREFIX) && key !== STORAGE_VERSION_KEY) {
        keys.push(key);
      }
    }
    return keys;
  }

  private readItems(area: globalThis.Storage, keys: readonly string[]): Map<string, string> {
    const items = new Map<string, string>();
    for (const key of keys) {
      const namespacedKey = key.slice(STORAGE_PREFIX.length);
      if (parseStorageKey(namespacedKey)) {
        const value = area.getItem(key);
        if (value !== null) {
          items.set(namespacedKey, value);
        }
      }
    }
    return items;
  }

  private migrate(
    area: globalThis.Storage, marker: string | null, version: number, items: Map<string, string>,
  ): Map<string, string> {
    const draft = new Map(items);
    for (let fromVersion = version; fromVersion < this.schemaVersion; fromVersion++) {
      const migrate = migrations.get(fromVersion);
      if (!migrate) {
        throw new Error(`No workbench storage migration from version ${fromVersion}.`);
      }
      migrate(draft);
    }

    const changes = new Map<string, string | null>();
    for (const key of items.keys()) {
      if (!draft.has(key)) {
        changes.set(STORAGE_PREFIX + key, null);
      }
    }
    for (const [key, value] of draft) {
      if (!parseStorageKey(key) || typeof value !== 'string') {
        throw new Error('Invalid entry in workbench storage migration.');
      }
      if (items.get(key) !== value) {
        changes.set(STORAGE_PREFIX + key, value);
      }
    }

    if (area.getItem(STORAGE_VERSION_KEY) !== marker) {
      throw new Error('Workbench storage schema changed during migration.');
    }
    const previous = new Map<string, string | null>();
    for (const key of changes.keys()) {
      const expected = items.get(key.slice(STORAGE_PREFIX.length)) ?? null;
      if (area.getItem(key) !== expected) {
        throw new Error('Workbench storage value changed during migration.');
      }
      previous.set(key, expected);
    }

    const applied: string[] = [];
    try {
      for (const [key, value] of changes) {
        this.write(area, key, value);
        applied.push(key);
      }
      if (area.getItem(STORAGE_VERSION_KEY) !== marker) {
        throw new Error('Workbench storage schema changed during migration.');
      }
      area.setItem(STORAGE_VERSION_KEY, this.versionText);
    } catch (error) {
      // Restore only this migration's writes while the schema marker still matches.
      for (const key of applied.reverse()) {
        if (area.getItem(key) === changes.get(key) && area.getItem(STORAGE_VERSION_KEY) === marker) {
          this.write(area, key, previous.get(key) ?? null);
        }
      }
      throw error;
    }
    return new Map(draft);
  }

  private checkVersion(area: globalThis.Storage): string | null {
    let marker = area.getItem(STORAGE_VERSION_KEY);
    if (marker === null) {
      const empty = this.prefixedKeys(area).length === 0;
      // A second tab can initialize this origin while the keys are being enumerated.
      marker = area.getItem(STORAGE_VERSION_KEY);
      if (marker === null && empty) {
        return null;
      }
    }
    if (marker === this.versionText) {
      return marker;
    }
    throw new Error('Workbench storage schema changed in another tab.');
  }

  private write(area: globalThis.Storage, key: string, value: string | null): void {
    if (value === null) {
      area.removeItem(key);
    } else {
      area.setItem(key, value);
    }
  }

  updateItems({ insert, delete: deleted }: IStorageUpdate): void {
    const area = this.area;
    if (!area) {
      return;
    }
    const marker = this.checkVersion(area);
    if (marker === null && insert.size > 0) {
      area.setItem(STORAGE_VERSION_KEY, this.versionText);
    }
    for (const key of deleted) {
      this.write(area, STORAGE_PREFIX + key, null);
    }
    for (const [key, value] of insert) {
      this.write(area, STORAGE_PREFIX + key, value);
    }
  }

  readExternal(event: StorageEvent): ReadonlyMap<string, string | undefined> | undefined {
    const area = this.area;
    if (!area || event.storageArea !== area) {
      return;
    }
    if (event.key === null) {
      this.checkVersion(area);
      return this.readItems(area, this.prefixedKeys(area));
    }
    if (event.key === STORAGE_VERSION_KEY) {
      this.checkVersion(area);
      return;
    }
    if (!event.key.startsWith(STORAGE_PREFIX)) {
      return;
    }
    const key = event.key.slice(STORAGE_PREFIX.length);
    if (parseStorageKey(key)) {
      this.checkVersion(area);
      // A queued event can arrive after another write to the same key in either tab.
      return new Map([[key, area.getItem(event.key) ?? undefined]]);
    }
  }

  close(): void {
    this.area = undefined;
  }
}

export class BrowserStorageService extends AbstractStorageService {
  constructor(browserWindow: Window = window, schemaVersion = STORAGE_SCHEMA_VERSION) {
    const database = new LocalStorageDatabase(() => browserWindow.localStorage, schemaVersion);
    super(database);
    const document = browserWindow.document;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void this.flush();
      }
    };
    const onPageHide = () => {
      void this.flush(WillSaveStateReason.SHUTDOWN);
    };
    const onStorage = (event: StorageEvent) => {
      try {
        const changes = database.readExternal(event);
        if (changes) {
          if (event.key === null) {
            for (const key of [...this.storage.keys()]) {
              if (!changes.has(key)) {
                this.acceptExternalValue(key, undefined);
              }
            }
          }
          for (const [key, value] of changes) {
            this.acceptExternalValue(key, value);
          }
        }
      } catch (error) {
        this.storage.useMemory(error);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    browserWindow.addEventListener('pagehide', onPageHide);
    browserWindow.addEventListener('storage', onStorage);
    this.disposables.add(toDisposable(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      browserWindow.removeEventListener('pagehide', onPageHide);
      browserWindow.removeEventListener('storage', onStorage);
    }));

    this.startIdleSave(save => {
      if (typeof browserWindow.requestIdleCallback === 'function') {
        const task = browserWindow.requestIdleCallback(save);
        return toDisposable(() => browserWindow.cancelIdleCallback(task));
      }
      const timer = browserWindow.setTimeout(save, 0);
      return toDisposable(() => browserWindow.clearTimeout(timer));
    });
  }
}
