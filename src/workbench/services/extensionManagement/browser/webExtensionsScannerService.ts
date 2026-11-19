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

  locked<T>(task: (read: () => readonly StoredWebExtension[], write: InstalledListWriter) => Promise<T>): Promise<T> {
    const run = () => {
      let active = true;
      const read = () => {
        if (!active) {
          throw new Error('The installed extensions lock was released.');
        }
        return parseInstalled(this.readPersisted());
      };
      const write: InstalledListWriter = extensions => {
        if (!active) {
          return Promise.reject(new Error('The installed extensions lock was released.'));
        }
        return this.save(extensions);
      };
      return task(read, write).finally(() => { active = false; });
    };
    // Tabs exclude each other with the Web Lock; this tab's own operations also queue without one.
    const result = this.queue.then(() => this.locks ? this.locks.request(installedExtensionsLockName, run) : run());
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  /** Reads the persisted value, which another tab may have written after this tab's cache. */
  private readPersisted(): string | undefined {
    let value: string | undefined;
    // A transform receives the persisted value. Writing it back unchanged keeps the stored text as it is.
    const current = this.storage.get(userExtensionsKey, scope);
    try {
      this.storage.storeImmediately(userExtensionsKey, stored => {
        value = stored;
        if (stored === undefined) {
          throw new NothingStored();
        }
        return stored;
      }, scope, StorageTarget.USER);
    } catch (error) {
      if (!(error instanceof NothingStored)) {
        throw error;
      }
      // The key is gone in storage. Forget a cached copy that another tab's removal has not reached yet.
      if (current !== undefined) {
        this.storage.remove(userExtensionsKey, scope);
      }
    }
    return value;
  }

  private async save(extensions: readonly StoredWebExtension[]): Promise<void> {
    if (extensions.length) {
      const text = JSON.stringify(extensions);
      this.storage.storeImmediately(userExtensionsKey, text, scope, StorageTarget.USER);
    } else {
      this.storage.remove(userExtensionsKey, scope);
      await this.storage.flush();
    }
  }
}

class NothingStored extends Error {}

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
