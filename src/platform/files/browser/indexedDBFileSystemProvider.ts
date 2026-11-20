import { IndexedDB, idbDirectoryKeys, idbRequest, idbStringPrefixRange } from '../../../base/browser/indexedDB.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { fileAuthority, isFileStoragePath, normalizeFileResource } from '../common/fileResource.js';
import { FileChangeType, FileSystemProviderError, FileSystemProviderErrorCode, FileType } from '../common/files.js';
import type { IFileChange } from '../common/files.js';
import { InMemoryFileTree } from '../common/inMemoryFilesystemProvider.js';
import { StoredFileSystemProvider } from '../common/storedFileSystemProvider.js';
import type { FileTreeStore, FileTreeTransactionMode, StoredEntry } from '../common/storedFileSystemProvider.js';

export const FILE_DATABASE_NAME = 'writing-room-files';
export const FILE_DATABASE_VERSION = 1;
const schemes = [Schemas.vscodeUserData, Schemas.vscodeVfs] as const;
type FileScheme = (typeof schemes)[number];

const Code = FileSystemProviderErrorCode;

export class BrowserFileDatabase implements IDisposable {
  private opened: Promise<IndexedDB | undefined> | undefined;
  private inMemory = false;
  private disposed = false;

  constructor(
    private readonly open = () => IndexedDB.open(FILE_DATABASE_NAME, FILE_DATABASE_VERSION, schemes),
    private readonly warn = (error: unknown) =>
      console.warn('Workbench file storage switched to memory. Files are kept for this session only.', error),
  ) {}

  get usesMemory(): boolean {
    return this.inMemory;
  }

  async get(): Promise<IndexedDB | undefined> {
    while (!this.disposed) {
      const opening = this.opened ??= Promise.resolve().then(this.open).catch(error => {
        if (!this.disposed) {
          this.inMemory = true;
          this.warn(error);
        }
        return undefined;
      });
      const database = await opening;
      if (this.disposed) {
        break;
      }
      if (!database?.isClosed) {
        return database;
      }
      // The original open can be shared by both schemes. Only its first waiter resets it.
      if (this.opened === opening) {
        this.opened = undefined;
      }
    }
    throw new FileSystemProviderError('File storage is closed', Code.Unavailable);
  }

  dispose(): void {
    this.disposed = true;
    void this.opened?.then(database => database?.dispose());
  }
}

export class IndexedDBFileSystemProvider extends StoredFileSystemProvider {
  private readonly memory = new InMemoryFileTree();
  private initializedChannel = false;
  private channel: BroadcastChannel | undefined;
  private disposed = false;

  constructor(private readonly database: BrowserFileDatabase, private readonly scheme: FileScheme) {
    super();
  }

  /** True once the database could not be opened and files live in this page. False before the first use. */
  get usesMemory(): boolean {
    return this.database.usesMemory;
  }

  override watch(resource: URI): IDisposable {
    const watch = super.watch(resource);
    void this.database.get().then(db => { if (db) { this.startChannel(); } }).catch(() => {});
    return watch;
  }

  protected override normalizeResource(resource: URI): URI {
    if (resource.scheme !== this.scheme) {
      throw new FileSystemProviderError('File system scheme does not match', Code.NoPermissions);
    }
    return normalizeFileResource(resource);
  }

  protected override async transaction<T>(
    mode: FileTreeTransactionMode, run: (store: FileTreeStore) => Promise<T>,
  ): Promise<T> {
    if (this.disposed) {
      throw new FileSystemProviderError('File system provider is closed', Code.Unavailable);
    }
    const database = await this.database.get();
    if (!database) {
      this.channel?.close();
      this.channel = undefined;
      return this.memory.transaction(mode, run);
    }
    this.startChannel();

    try {
      return await database.runInTransaction(this.scheme, mode, native => run({
        get: async path => isFileStoragePath(this.scheme, path)
          ? validateEntry(await idbRequest<unknown>(native.get(path))) : undefined,
        keys: async (prefix, immediate) => immediate
          ? idbDirectoryKeys(native, prefix)
          : (await idbRequest(native.getAllKeys(idbStringPrefixRange(prefix))))
            .filter((key): key is string => typeof key === 'string'),
        set: async (path, entry) => { await idbRequest(native.put(entry, path)); },
        delete: async path => { await idbRequest(native.delete(path)); },
      }));
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'QuotaExceededError') {
          throw new FileSystemProviderError('File storage quota exceeded', Code.FileExceedsStorageQuota, { cause: error });
        }
        if (error.name === 'InvalidStateError' || error.name === 'AbortError') {
          throw new FileSystemProviderError('File storage transaction unavailable', Code.Unavailable, { cause: error });
        }
      }
      throw error;
    }
  }

  protected override emitChanges(changes: readonly IFileChange[]): void {
    // Publish only after the transaction commits. A channel failure does not invalidate a committed write.
    if (changes.length && this.channel && !this.database.usesMemory) {
      try {
        this.channel.postMessage({
          version: FILE_DATABASE_VERSION,
          changes: changes.map(({ resource, type }) => ({ path: resource.path, type })),
        });
      } catch {
        // The tab can close its channel while a transaction is finishing.
      }
    }
    super.emitChanges(changes);
  }

  override dispose(): void {
    this.disposed = true;
    this.channel = undefined;
    super.dispose();
  }

  private startChannel(): void {
    if (this.initializedChannel || this.disposed) {
      return;
    }
    this.initializedChannel = true;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const channel = new BroadcastChannel(FILE_DATABASE_NAME + '/' + this.scheme);
        channel.onmessage = ({ data }: MessageEvent<unknown>) => this.receiveChanges(data);
        this.channel = channel;
        this._register(toDisposable(() => channel.close()));
      } catch {
        // Some browser contexts disable messaging independently of storage.
      }
    }
  }

  private receiveChanges(message: unknown): void {
    if (this.database.usesMemory || !message || typeof message !== 'object' || !('version' in message) || message.version !== FILE_DATABASE_VERSION
      || !('changes' in message) || !Array.isArray(message.changes)) {
      return;
    }
    const changes: IFileChange[] = [];
    for (const change of message.changes as unknown[]) {
      if (!change || typeof change !== 'object' || !('path' in change) || typeof change.path !== 'string'
        || !('type' in change) || (change.type !== FileChangeType.ADDED
          && change.type !== FileChangeType.UPDATED && change.type !== FileChangeType.DELETED)) {
        return;
      }
      const resource = this.revivePath(change.path);
      if (!resource) {
        return;
      }
      changes.push({ resource, type: change.type });
    }
    super.emitChanges(changes);
  }

  private revivePath(path: string): URI | undefined {
    if (path !== '/' && isFileStoragePath(this.scheme, path)) {
      return URI.from({ scheme: this.scheme, authority: fileAuthority(this.scheme), path });
    }
  }
}

function validateEntry(data: unknown): StoredEntry | undefined {
  if (!data || typeof data !== 'object') {
    return;
  }
  const { type, ctime, mtime, size, bytes } = data as Partial<StoredEntry> & { bytes?: unknown };
  if (typeof ctime !== 'number' || !Number.isSafeInteger(ctime) || ctime < 0
    || typeof mtime !== 'number' || !Number.isSafeInteger(mtime) || mtime < ctime) {
    return;
  }
  if (type === FileType.Directory && size === 0) {
    return { type, ctime, mtime, size };
  }
  if (type === FileType.File && bytes instanceof Blob && size === bytes.size) {
    return { type, ctime, mtime, size, bytes };
  }
}
