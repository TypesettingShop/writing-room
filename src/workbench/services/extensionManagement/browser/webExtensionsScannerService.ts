import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget, storageKey } from '../../../../platform/storage/common/storage.js';
import { registerStorageMigration } from '../../storage/browser/storageService.js';
import { IWebExtensionsScannerService, validateStoredExtension } from '../common/extensionManagementService.js';
import type { InstalledListWriter, StoredWebExtension } from '../common/extensionManagementService.js';

export const userExtensionsKey = 'extensions.user';
const scope = StorageScope.PROFILE;
export const installedExtensionsLockName = 'writing-room:extensions.user';

/** The part of the Web Locks API the installed list uses. */
export interface InstalledListLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function browserLocks(): InstalledListLocks | undefined {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks && { request: (name, callback) => locks.request(name, { mode: 'exclusive' }, callback) };
}

// Schema 1 records were folder URL installs without a source or a version of their own.
registerStorageMigration(1, draft => {
  const key = storageKey(scope, userExtensionsKey);
  const raw = draft.get(key);
  let entries: unknown;
  try {
    entries = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return;
  }
  if (Array.isArray(entries)) {
    draft.set(key, JSON.stringify(entries.map(entry => isRecord(entry) ? {
      ...entry,
      // Schema 1 compared identifiers without case; schema 2 records hold the lower-case identifier.
      ...(typeof entry.identifier === 'string' ? { identifier: entry.identifier.toLowerCase() } : {}),
      source: 'location',
      ...(isRecord(entry.manifest) && typeof entry.manifest.version === 'string' ? { version: entry.manifest.version } : {}),
    } : entry)));
  }
});

export class WebExtensionsScannerService implements IWebExtensionsScannerService {
  declare readonly _serviceBrand: undefined;
  private queue = Promise.resolve();
  private readonly locks: InstalledListLocks | undefined;

  constructor(
    locks: InstalledListLocks | null | undefined,
    @IStorageService private readonly storage: IStorageService,
  ) {
    this.locks = locks === undefined ? browserLocks() : locks ?? undefined;
  }

  scanUserExtensions(): readonly StoredWebExtension[] {
    return parseInstalled(this.storage.get(userExtensionsKey, scope));
  }

  get sessionOnly(): boolean {
    return this.storage.usesMemory;
  }

  locked<T>(task: (
    read: () => readonly StoredWebExtension[], write: InstalledListWriter, locations: () => ReadonlySet<string> | undefined,
  ) => Promise<T>): Promise<T> {
    const run = () => {
      let active = true;
      const persisted = () => {
        if (!active) {
          throw new Error('The installed extensions lock was released.');
        }
        // The persisted value, which another tab may have written after this tab's cache. In memory mode it is
        // this tab's list, and the backend is not reopened.
        return this.storage.getPersisted(userExtensionsKey, scope);
      };
      const read = () => parseInstalled(persisted());
      // A session-only list cannot tell which package folders the persisted records name.
      const locations = () => {
        const raw = persisted();
        return this.storage.usesMemory ? undefined : recordedLocations(raw);
      };
      const write: InstalledListWriter = extensions => {
        if (!active) {
          return Promise.reject(new Error('The installed extensions lock was released.'));
        }
        return this.save(extensions);
      };
      return task(read, write, locations).finally(() => { active = false; });
    };
    // Tabs exclude each other with the Web Lock; this tab's own operations also queue without one. A tab in memory
    // mode shares no list with the others, and a browser that blocks storage denies the lock as well.
    const result = this.queue.then(() =>
      this.locks && !this.storage.usesMemory ? this.locks.request(installedExtensionsLockName, run) : run());
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private async save(extensions: readonly StoredWebExtension[]): Promise<void> {
    if (this.storage.usesMemory) {
      // Only this tab's list changes. Reopening the backend would throw where the browser blocks storage.
      if (extensions.length) {
        this.storage.store(userExtensionsKey, JSON.stringify(extensions), scope, StorageTarget.USER);
      } else {
        this.storage.remove(userExtensionsKey, scope);
      }
      return;
    }
    // Every list, the empty one too, is an explicit write that reports a failure before the caller goes on to
    // remove package folders. An empty list then drops its key, which reads back the same.
    this.storage.storeImmediately(userExtensionsKey, JSON.stringify(extensions), scope, StorageTarget.USER);
    if (!extensions.length) {
      this.storage.remove(userExtensionsKey, scope);
    }
  }
}

/** Every location string a saved record names, valid or not; undefined when the list itself cannot be parsed. */
function recordedLocations(raw: string | undefined): ReadonlySet<string> | undefined {
  let entries: unknown;
  try {
    entries = raw ? JSON.parse(raw) : [];
  } catch {
    return undefined;
  }
  return Array.isArray(entries)
    ? new Set(entries.flatMap(entry => isRecord(entry) && typeof entry.location === 'string' ? [entry.location] : []))
    : undefined;
}

function parseInstalled(raw: string | undefined): readonly StoredWebExtension[] {
  if (!raw) {
    return [];
  }
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
    if (!Array.isArray(entries)) {
      throw new Error('Expected an array.');
    }
  } catch (error) {
    console.warn('Could not read the installed extensions list.', error);
    return [];
  }
  const installed = new Map<string, StoredWebExtension>();
  for (const entry of entries) {
    try {
      const extension = validateStoredExtension(entry);
      if (installed.has(extension.identifier)) {
        throw new Error(`Duplicate identifier '${extension.identifier}'.`);
      }
      installed.set(extension.identifier, extension);
    } catch (error) {
      console.warn('Skipping an invalid installed extension.', error);
    }
  }
  return [...installed.values()];
}

registerSingleton(IWebExtensionsScannerService, WebExtensionsScannerService);
