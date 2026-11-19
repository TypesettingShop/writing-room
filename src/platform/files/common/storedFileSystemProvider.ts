import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../base/common/path.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import { normalizeFileResource } from './fileResource.js';
import {
  etag, FileChangeType, FileOperationError, FileOperationResult, FileSystemProviderCapabilities,
  FileSystemProviderError, FileSystemProviderErrorCode, FileType,
} from './files.js';
import type {
  IFileChange, IFileDeleteOptions, IFileOverwriteOptions, IFileReadOptions, IFileSystemProvider,
  IFileWriteOptions, IMkdirOptions, IStat,
} from './files.js';

export interface StoredFile extends IStat {
  readonly type: FileType.File;
  readonly bytes: Blob;
}

export interface StoredDirectory extends IStat {
  readonly type: FileType.Directory;
}

export type StoredEntry = StoredFile | StoredDirectory;
export type FileTreeTransactionMode = 'readonly' | 'readwrite';

export interface FileTreeStore {
  get(path: string): Promise<StoredEntry | undefined>;
  /** Return keys below the trailing-slash prefix, excluding the root key itself. */
  keys(prefix: string): Promise<readonly string[]>;
  set(path: string, entry: StoredEntry): Promise<void>;
  delete(path: string): Promise<void>;
}

const root: StoredDirectory = { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
const Code = FileSystemProviderErrorCode;

export abstract class StoredFileSystemProvider extends Disposable implements IFileSystemProvider {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive
    | FileSystemProviderCapabilities.FileFolderCopy | FileSystemProviderCapabilities.FileAtomicWrite
    | FileSystemProviderCapabilities.CreateParents;

  private readonly fileChanges = this._register(new Emitter<readonly IFileChange[]>());
  readonly onDidChangeFile = this.fileChanges.event;

  protected abstract transaction<T>(mode: FileTreeTransactionMode, run: (store: FileTreeStore) => Promise<T>): Promise<T>;

  protected emitChanges(changes: readonly IFileChange[]): void {
    if (changes.length) {
      this.fileChanges.fire(changes);
    }
  }

  watch(resource: URI): IDisposable {
    // The store already emits changes for its entire scheme.
    this.normalizeResource(resource);
    return Disposable.None;
  }

  async stat(resource: URI): Promise<IStat> {
    const { path } = this.normalizeResource(resource);
    return this.transaction('readonly', async store => fileStat(await getEntry(store, path)));
  }

  async readdir(resource: URI): Promise<readonly [string, FileType][]> {
    const { path } = this.normalizeResource(resource);
    return this.transaction('readonly', async store => {
      requireDirectory(await getEntry(store, path), path);
      const prefix = childPrefix(path);
      const keys = (await store.keys(prefix)).filter(key => !key.slice(prefix.length).includes('/'));
      const entries = await Promise.all(keys.map(async key => [basename(key), await store.get(key)] as const));
      return entries.flatMap(([name, entry]) => entry ? [[name, entry.type]] : []);
    });
  }

  async readFile(resource: URI, options?: IFileReadOptions): Promise<Uint8Array> {
    return (await this.readFileWithStat(resource, options)).value;
  }

  async readFileWithStat(resource: URI, options?: IFileReadOptions): Promise<{ stat: IStat; value: Uint8Array }> {
    options?.signal?.throwIfAborted();
    const { path } = this.normalizeResource(resource);
    const entry = await this.transaction('readonly', store => getEntry(store, path));
    if (entry.type !== FileType.File) {
      throw new FileSystemProviderError(path, Code.FileIsADirectory);
    }
    const limit = options?.limits?.size;
    if (limit !== undefined && entry.size > limit) {
      throw new FileSystemProviderError(`File exceeds ${limit} bytes: ${path}`, Code.FileTooLarge);
    }
    options?.signal?.throwIfAborted();
    const value = new Uint8Array(await entry.bytes.arrayBuffer());
    options?.signal?.throwIfAborted();
    return { stat: fileStat(entry), value };
  }

  async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions): Promise<IStat> {
    resource = this.normalizeResource(resource);
    const { path } = resource;
    // Blob copies its parts. Only a view of shared memory needs its own buffer first.
    const bytes = new Blob([content.buffer instanceof ArrayBuffer ? content as Uint8Array<ArrayBuffer> : content.slice()]);
    return this.mutate(resource, async (store, changed) => {
      const existing = await lookup(store, path);
      if (existing?.type === FileType.Directory) {
        throw new FileSystemProviderError(path, Code.FileIsADirectory);
      }
      if (options.etag !== undefined && (!existing || options.etag !== etag(existing))) {
        throw new FileOperationError(`File has been modified since it was read: ${path}`,
          FileOperationResult.FILE_MODIFIED_SINCE);
      }
      if (existing ? !options.overwrite : !options.create) {
        throw new FileSystemProviderError(path, existing ? Code.FileExists : Code.FileNotFound);
      }
      const parent = dirname(path);
      if (options.createParents) {
        await makeDirectories(store, parent, changed);
      } else {
        requireDirectory(await getEntry(store, parent), parent);
      }
      const now = Date.now();
      const record: StoredFile = {
        type: FileType.File, ctime: existing?.ctime ?? now,
        mtime: existing ? Math.max(now, existing.mtime + 1) : now, size: bytes.size, bytes,
      };
      await store.set(path, record);
      changed(path, existing ? FileChangeType.UPDATED : FileChangeType.ADDED);
      return fileStat(record);
    });
  }

  async mkdir(resource: URI, options?: IMkdirOptions): Promise<void> {
    resource = this.normalizeResource(resource);
    const { path } = resource;
    await this.mutate(resource, async (store, changed) => {
      if (!options?.recursive) {
        const parent = dirname(path);
        requireDirectory(await getEntry(store, parent), parent);
      }
      await makeDirectories(store, path, changed);
    });
  }

  async rename(from: URI, to: URI, options: IFileOverwriteOptions): Promise<void> {
    await this.transfer(from, to, options, true);
  }

  async copy(from: URI, to: URI, options: IFileOverwriteOptions): Promise<void> {
    await this.transfer(from, to, options, false);
  }

  private async transfer(from: URI, to: URI, options: IFileOverwriteOptions, move: boolean): Promise<void> {
    from = this.normalizeResource(from);
    to = this.normalizeResource(to);
    const source = from.path;
    const target = to.path;
    await this.mutate(from, async (store, changed) => {
      const entry = await getEntry(store, source);
      if (source === target && move) {
        return;
      }
      // A copy onto itself would delete the source tree as the overwritten target before reading it.
      if (source === '/' || target === '/' || source === target
        || target.startsWith(childPrefix(source)) || source.startsWith(childPrefix(target))) {
        throw new FileSystemProviderError('Cannot transfer overlapping file trees', Code.NoPermissions);
      }
      const existing = await lookup(store, target);
      if (existing && !options.overwrite) {
        throw new FileSystemProviderError(target, Code.FileExists);
      }
      await makeDirectories(store, dirname(target), changed);
      const overwritten = existing ? await treeEntries(store, target, existing) : [];
      await Promise.all(overwritten.map(([key]) => store.delete(key)));
      if (existing) {
        changed(target, FileChangeType.DELETED);
      }

      const previous = new Map(overwritten);
      const entries = await treeEntries(store, source, entry);
      const now = Date.now();
      // The trees do not overlap, so the requests can be queued together without awaiting each one.
      await Promise.all(entries.flatMap(([key, value]) => {
        const destination = target + key.slice(source.length);
        const replaced = previous.get(destination);
        changed(destination, FileChangeType.ADDED);
        const write = store.set(destination, {
          ...value,
          ctime: move ? value.ctime : now,
          mtime: Math.max(move ? value.mtime : now, replaced ? replaced.mtime + 1 : 0),
        });
        return move ? [write, store.delete(key)] : [write];
      }));
      if (move) {
        changed(source, FileChangeType.DELETED);
      }
    });
  }

  async delete(resource: URI, options: IFileDeleteOptions): Promise<void> {
    resource = this.normalizeResource(resource);
    const { path } = resource;
    if (path === '/') {
      throw new FileSystemProviderError('Cannot delete the file system root', Code.NoPermissions);
    }
    await this.mutate(resource, async (store, changed) => {
      const entry = await getEntry(store, path);
      const keys = entry.type === FileType.Directory ? await store.keys(childPrefix(path)) : [];
      if (keys.length && !options.recursive) {
        throw new FileSystemProviderError(`Directory is not empty: ${path}`, Code.NoPermissions);
      }
      await Promise.all([...keys, path].map(key => store.delete(key)));
      changed(path, FileChangeType.DELETED);
    });
  }

  protected normalizeResource(resource: URI): URI {
    return normalizeFileResource(resource);
  }

  private async mutate<T>(
    resource: URI, run: (store: FileTreeStore, change: (path: string, type: FileChangeType) => void) => Promise<T>,
  ): Promise<T> {
    const changes: IFileChange[] = [];
    const result = await this.transaction('readwrite', store => run(store,
      (path, type) => changes.push({ resource: resource.with({ path }), type })));
    this.emitChanges(changes);
    return result;
  }
}

function fileStat({ type, ctime, mtime, size }: IStat): IStat {
  return { type, ctime, mtime, size };
}

function childPrefix(path: string): string {
  return path === '/' ? '/' : path + '/';
}

async function lookup(store: FileTreeStore, path: string): Promise<StoredEntry | undefined> {
  if (path === '/') {
    return root;
  }
  const entry = await store.get(path);
  if (entry) {
    return entry;
  }
  // A missing entry can actually be an illegal descent through a file.
  for (let ancestor = dirname(path); ancestor !== '/'; ancestor = dirname(ancestor)) {
    const parent = await store.get(ancestor);
    if (parent?.type === FileType.File) {
      throw new FileSystemProviderError(ancestor, Code.FileNotADirectory);
    }
    if (parent) {
      break;
    }
  }
}

async function getEntry(store: FileTreeStore, path: string): Promise<StoredEntry> {
  const entry = await lookup(store, path);
  if (!entry) {
    throw new FileSystemProviderError(path, Code.FileNotFound);
  }
  return entry;
}

function requireDirectory(entry: StoredEntry, path: string): void {
  if (entry.type !== FileType.Directory) {
    throw new FileSystemProviderError(path, Code.FileNotADirectory);
  }
}

async function makeDirectories(
  store: FileTreeStore, path: string, changed: (path: string, type: FileChangeType) => void,
): Promise<void> {
  const missing: string[] = [];
  for (let current = path; current !== '/'; current = dirname(current)) {
    const entry = await store.get(current);
    if (entry) {
      requireDirectory(entry, current);
      break;
    }
    missing.push(current);
  }
  const time = Date.now();
  for (const current of missing.reverse()) {
    await store.set(current, { type: FileType.Directory, ctime: time, mtime: time, size: 0 });
    changed(current, FileChangeType.ADDED);
  }
}

async function treeEntries(
  store: FileTreeStore, path: string, entry: StoredEntry,
): Promise<readonly [string, StoredEntry][]> {
  const result: [string, StoredEntry][] = [[path, entry]];
  if (entry.type === FileType.Directory) {
    const keys = await store.keys(childPrefix(path));
    const children = await Promise.all(keys.map(key => store.get(key)));
    keys.forEach((key, index) => {
      const child = children[index];
      if (child) {
        result.push([key, child]);
      }
    });
  }
  return result;
}
