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

function isCurrentInstallation(snapshot: ReadonlyMap<string, string>, installation: Installation): boolean {
  try {
    const entries: unknown = JSON.parse(snapshot.get(installedAddress) ?? '[]');
    return Array.isArray(entries) && entries.some(entry => entry?.identifier === installation.identifier
      && entry.installedAt === installation.installedAt && entry.location === installation.location);
  } catch {
    return false;
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

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    const result = this.queue.then(() => locks ? locks.request('writing-room:extensions.state', task) : task());
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
      const address = storageKey(storageScope, key);
      this.storage.storeImmediately(key, (stored, snapshot) => {
        if (installation && !isCurrentInstallation(snapshot, installation)) {
          throw new Error(`Extension '${id}' is no longer installed.`);
        }
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
        for (const [other, text] of snapshot) {
          if (other !== address && (other.startsWith(storageKey(StorageScope.PROFILE, prefix))
            || other.startsWith(storageKey(StorageScope.WORKSPACE, prefix)))) {
            total += measure(text);
          }
        }
        if (total > maxAllState && size > (stored === undefined ? 0 : measure(stored))) {
          throw new Error('Extensions exceed the 2 MiB total state limit.');
        }
        return next;
      }, storageScope, StorageTarget.USER);
    });
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

  async clear(id: string): Promise<void> {
    await this.serialize(async () => {
      for (const scope of Object.values(scopeFor)) {
        this.storage.storeImmediately(prefix + id, () => undefined, scope, StorageTarget.USER);
      }
      this.secrets.delete(id);
    });
    const paths = [extensionGlobalStorageUri(id), extensionWorkspaceStorageUri(this.workspace.getWorkspace().id, id), extensionLogUri(id)];
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
