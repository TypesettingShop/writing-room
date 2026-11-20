import { userExtensionsKey } from '../../services/extensionManagement/browser/webExtensionsScannerService.js';
import type { StoredWebExtension } from '../../services/extensionManagement/common/extensionManagementService.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { IFileService, FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../platform/files/common/files.js';
import { registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget, storageKey } from '../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { extensionGlobalStorageUri, extensionLogUri, extensionWorkspaceStorageUri } from '../../services/extensions/common/extensionStoragePaths.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { ExtensionStateScope, ExtHostStorageShape, MainThreadStorageShape } from '../common/extHost.protocol.runtime.js';
import { Emitter } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';

const prefix = 'extensions.state.';
const maxState = 256 * 1024;
const maxAllState = 2 * 1024 * 1024;
const measure = (text: string) => new TextEncoder().encode(text).byteLength;
const scopeFor = { global: StorageScope.PROFILE, workspace: StorageScope.WORKSPACE } as const;
const installedAddress = storageKey(StorageScope.PROFILE, userExtensionsKey);
const emptyState = '{}';

function parseState(text: string | undefined): Record<string, unknown> {
  if (!text || measure(text) > maxState) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid state starts empty.
  }
  return {};
}

function validateName(name: unknown): asserts name is string {
  if (typeof name !== 'string') {
    throw new TypeError('An extension storage key must be a string.');
  }
}

type Installation = Pick<StoredWebExtension, 'identifier' | 'installedAt' | 'location'>;

function isCurrentInstallation(stored: string | undefined, installation: Installation): boolean {
  try {
    const entries: unknown = JSON.parse(stored ?? '[]');
    return Array.isArray(entries) && entries.some(entry => entry?.identifier === installation.identifier
      && entry.installedAt === installation.installedAt && entry.location === installation.location);
  } catch {
    return false;
  }
}

function nextState(
  id: string, name: string, json: string | undefined, stored: string | undefined, otherStates: Iterable<string>,
): string | undefined {
  const state: Record<string, unknown> = Object.assign(Object.create(null), parseState(stored));
  if (json === undefined) {
    delete state[name];
  } else {
    state[name] = JSON.parse(json);
  }
  const next = JSON.stringify(state);
  const size = measure(next);
  if (size > maxState) {
    throw new Error(`Extension '${id}' exceeds the 256 KiB state limit.`);
  }
  if (next === emptyState) {
    return undefined;
  }
  let total = size;
  for (const text of otherStates) {
    total += measure(text);
  }
  if (total > maxAllState && size > (stored === undefined ? 0 : measure(stored))) {
    throw new Error('Extensions exceed the 2 MiB total state limit.');
  }
  return next;
}

function* otherPersistedStates(snapshot: ReadonlyMap<string, string>, address: string): IterableIterator<string> {
  const profilePrefix = storageKey(StorageScope.PROFILE, prefix);
  const workspacePrefix = storageKey(StorageScope.WORKSPACE, prefix);
  for (const [other, text] of snapshot) {
    if (other !== address && (other.startsWith(profilePrefix) || other.startsWith(workspacePrefix))) {
      yield text;
    }
  }
}

export const IExtensionStorage = createDecorator<ExtensionStorage>('extensionStorage');

/** Workbench-owned state. Session secrets survive replacement of the extension host. */
export class ExtensionStorage extends Disposable {
  declare readonly _serviceBrand: undefined;
  private readonly secrets = new Map<string, Map<string, string>>();
  private readonly secretChange = this._register(new Emitter<{ id: string; name: string }>());
  readonly onDidChangeSecret = this.secretChange.event;
  private queue = Promise.resolve();

  constructor(
    @IStorageService readonly storage: IStorageService,
    @IFileService private readonly files: IFileService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
  ) {
    super();
  }

  /**
   * Queue the task behind this tab's earlier state changes. Skip the cross-tab lock only when `inTabOnly`
   * confirms at queue entry that the task will use this tab's cache for both reads and writes.
   */
  private serialize<T>(task: () => Promise<T>, inTabOnly: () => boolean): Promise<T> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    const result = this.queue.then(() =>
      locks && !inTabOnly() ? locks.request('writing-room:extensions.state', task) : task());
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  read(id: string, scope: ExtensionStateScope): string {
    return JSON.stringify(parseState(this.storage.get(prefix + id, scopeFor[scope])));
  }

  update(
    id: string, scope: ExtensionStateScope, name: string, json: string | undefined, isLive: () => boolean,
    installation?: Installation,
  ): Promise<void> {
    return this.serialize(async () => {
      if (!isLive()) {
        throw new Error(`Extension '${id}' is no longer registered.`);
      }
      const storageScope = scopeFor[scope];
      const key = prefix + id;
      // A tab can fall back while waiting for the lock. Memory mode is permanent for this tab.
      if (this.storage.usesMemory) {
        if (installation && !isCurrentInstallation(this.storage.get(userExtensionsKey, StorageScope.PROFILE), installation)) {
          throw new Error(`Extension '${id}' is no longer installed.`);
        }
        const stored = this.storage.get(key, storageScope);
        const next = nextState(id, name, json, stored, this.otherCachedStates(storageScope, key));
        if (next === undefined) {
          this.storage.remove(key, storageScope);
        } else {
          this.storage.store(key, next, storageScope, StorageTarget.USER);
        }
        return;
      }

      const address = storageKey(storageScope, key);
      this.storage.storeImmediately(key, (stored, snapshot) => {
        if (installation && !isCurrentInstallation(snapshot.get(installedAddress), installation)) {
          throw new Error(`Extension '${id}' is no longer installed.`);
        }
        return nextState(id, name, json, stored, otherPersistedStates(snapshot, address));
      }, storageScope, StorageTarget.USER);
    }, () => this.storage.usesMemory);
  }

  private *otherCachedStates(scope: StorageScope, key: string): IterableIterator<string> {
    for (const otherScope of Object.values(scopeFor)) {
      for (const otherKey of this.storage.keys(otherScope)) {
        if (otherKey.startsWith(prefix) && (otherKey !== key || otherScope !== scope)) {
          const text = this.storage.get(otherKey, otherScope);
          if (text !== undefined) {
            yield text;
          }
        }
      }
    }
  }

  getSecret(id: string, name: string): string | undefined {
    return this.secrets.get(id)?.get(name);
  }

  getSecretKeys(id: string): string[] {
    return [...this.secrets.get(id)?.keys() ?? []];
  }

  setSecret(id: string, name: string, value: string | undefined): void {
    if (this.getSecret(id, name) === value) {
      return;
    }
    if (value === undefined) {
      this.secrets.get(id)?.delete(name);
    } else {
      const entries = this.secrets.get(id) ?? new Map<string, string>();
      entries.set(name, value);
      this.secrets.set(id, entries);
    }
    this.secretChange.fire({ id, name });
  }

  /**
   * Removes the extension's state, secrets and storage folders. In memory mode only this tab's state goes, and
   * the folders stay when the files persist: the extension can still be in the persisted list and find them again.
   */
  async clear(id: string): Promise<void> {
    // Read once, so the folders follow the state: a fallback after the persisted state went must not keep them.
    let inMemory = false;
    // A tab in memory mode shares no state with the others, and a browser that blocks storage denies the lock too.
    await this.serialize(async () => {
      inMemory = this.storage.usesMemory;
      for (const scope of Object.values(scopeFor)) {
        if (inMemory) {
          this.storage.remove(prefix + id, scope);
        } else {
          this.storage.storeImmediately(prefix + id, () => undefined, scope, StorageTarget.USER);
        }
      }
      this.secrets.delete(id);
    }, () => this.storage.usesMemory);
    const paths = [extensionGlobalStorageUri(id), extensionWorkspaceStorageUri(this.workspace.getWorkspace().id, id), extensionLogUri(id)];
    if (inMemory && await this.filesPersist(paths[0])) {
      return;
    }
    await Promise.all(paths.map(async uri => {
      try {
        await this.files.del(uri, { recursive: true });
      } catch (error) {
        if (toFileSystemProviderErrorCode(error) !== FileSystemProviderErrorCode.FileNotFound) {
          throw error;
        }
      }
    }));
  }

  private async filesPersist(uri: URI): Promise<boolean> {
    // The user data provider says whether it fell back to memory only once its database was opened.
    await this.files.exists(uri);
    return this.files.getProvider(uri.scheme)?.usesMemory !== true;
  }
}

registerSingleton(IExtensionStorage, ExtensionStorage);

export class MainThreadStorage extends Disposable implements MainThreadStorageShape {
  private readonly subscriptions = this._register(new DisposableStore());
  private readonly subscribed = new Map<string, string>();
  private readonly installations = new Map<string, Installation>();

  constructor(
    private readonly state: ExtensionStorage,
    private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
    private readonly proxy: ExtHostStorageShape,
    private readonly installed: () => readonly Installation[],
  ) {
    super();
    for (const scope of ['global', 'workspace'] as const) {
      this.state.storage.onDidChangeValue(scopeFor[scope], undefined, this.subscriptions)(({ key }) => {
        if (!key.startsWith(prefix)) {
          return;
        }
        const id = key.slice(prefix.length);
        for (const [extension, subscribed] of this.subscribed) {
          if (subscribed === id) {
            void Promise.resolve(this.proxy.$acceptState(extension, scope, this.state.read(id, scope))).catch(() => {});
          }
        }
      });
    }
    this._register(this.state.onDidChangeSecret(({ id, name }) => {
      for (const [extension, subscribed] of this.subscribed) {
        if (subscribed === id) {
          void Promise.resolve(this.proxy.$acceptSecretChange(extension, name)).catch(() => {});
        }
      }
    }));
  }

  private id(key: string): string {
    const extension = typeof key === 'string' ? this.getExtension(key) : undefined;
    if (!extension) {
      throw new Error('The extension is no longer registered.');
    }
    return extension.id;
  }

  private installation(key: string, id: string): Installation | undefined {
    const extension = this.getExtension(key);
    if (!extension || extension.isBuiltin) {
      return undefined;
    }
    const record = this.installations.get(key) ?? this.installed().find(item =>
      item.identifier === id && item.location === extension.location);
    // Folder installs register before saving their record. Retry an initial miss on the next write.
    if (record) {
      this.installations.set(key, record);
    }
    return record;
  }

  async $initialize(key: string): Promise<{ global: string; workspace: string }> {
    const id = this.id(key);
    this.subscribed.set(key, id);
    this.installation(key, id);
    return { global: this.state.read(id, 'global'), workspace: this.state.read(id, 'workspace') };
  }

  async $update(key: string, scope: ExtensionStateScope, name: string, json: string | undefined): Promise<void> {
    const id = this.id(key);
    validateName(name);
    if (!Object.hasOwn(scopeFor, scope) || (json !== undefined && (typeof json !== 'string' || measure(json) > maxState))) {
      throw new Error('Invalid extension state update.');
    }
    const installation = this.installation(key, id);
    await this.state.update(id, scope, name, json, () => this.getExtension(key)?.id === id, installation);
  }

  async $getSecret(key: string, name: string): Promise<string | undefined> {
    validateName(name);
    return this.state.getSecret(this.id(key), name);
  }

  async $getSecretKeys(key: string): Promise<string[]> {
    return this.state.getSecretKeys(this.id(key));
  }

  async $setSecret(key: string, name: string, value: string | undefined): Promise<void> {
    validateName(name);
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError('An extension secret must be a string.');
    }
    this.state.setSecret(this.id(key), name, value);
  }

  remove(key: string): void {
    this.subscribed.delete(key);
    this.installations.delete(key);
  }

  override dispose(): void {
    this.subscribed.clear();
    this.installations.clear();
    super.dispose();
  }
}
