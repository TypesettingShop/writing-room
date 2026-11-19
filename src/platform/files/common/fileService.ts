import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { basename, dirname, isEqualOrParent, joinPath } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import {
  etag, FileChangesEvent, FileOperation, FileOperationError, FileOperationEvent, FileOperationResult,
  FileSystemProviderCapabilities, FileSystemProviderError, FileSystemProviderErrorCode, FileType, toFileSystemProviderErrorCode,
} from './files.js';
import type {
  IFileChange, IFileContent, IFileDeleteOptions, IFileOperationParticipantEvent, IFileOverwriteOptions,
  IFileReadOptions, IFileService, IFileStat, IFileSystemProvider, IFileSystemProviderActivationEvent,
  IFileSystemProviderRegistrationEvent, IStat, IWatchOptions, IWriteFileOptions,
} from './files.js';

const Code = FileSystemProviderErrorCode;
const Cap = FileSystemProviderCapabilities;

export class FileService extends Disposable implements IFileService {
  declare readonly _serviceBrand: undefined;

  private readonly providerRegistrations = this._register(new DisposableStore());
  private readonly providers = new Map<string, IFileSystemProvider>();
  private readonly activations = new Map<string, Promise<void>>();
  private readonly pendingChanges = new Map<string, IFileChange>();

  private readonly registration = this._register(new Emitter<IFileSystemProviderRegistrationEvent>());
  readonly onDidChangeFileSystemProviderRegistrations = this.registration.event;

  private readonly activate = this._register(new Emitter<IFileSystemProviderActivationEvent>());
  readonly onWillActivateFileSystemProvider = this.activate.event;

  private readonly filesChanged = this._register(new Emitter<FileChangesEvent>());
  readonly onDidFilesChange = this.filesChanged.event;

  private readonly willRun = this._register(new Emitter<IFileOperationParticipantEvent>());
  readonly onWillRunOperation = this.willRun.event;

  private readonly didRun = this._register(new Emitter<FileOperationEvent>());
  readonly onDidRunOperation = this.didRun.event;

  private readonly watchError = this._register(new Emitter<unknown>());
  readonly onDidWatchError = this.watchError.event;

  registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable {
    if (this.providers.has(scheme)) {
      throw new Error(`A file system provider for the scheme '${scheme}' is already registered.`);
    }
    this.providers.set(scheme, provider);
    const listener = provider.onDidChangeFile(changes => this.queueChanges(scheme, changes));
    const registration = this.providerRegistrations.add(toDisposable(() => {
      listener.dispose();
      this.providers.delete(scheme);
      this.providerRegistrations.delete(registration);
      this.registration.fire({ scheme, added: false, provider });
    }));
    this.registration.fire({ scheme, added: true, provider });
    return registration;
  }

  getProvider(scheme: string): IFileSystemProvider | undefined {
    return this.providers.get(scheme);
  }

  hasProvider(resource: URI): boolean {
    return this.providers.has(resource.scheme);
  }

  async activateProvider(scheme: string): Promise<void> {
    if (this.providers.has(scheme)) {
      return;
    }
    let activation = this.activations.get(scheme);
    if (!activation) {
      activation = Promise.resolve().then(async () => {
        const pending: PromiseLike<unknown>[] = [];
        this.activate.fire({ scheme, join: promise => pending.push(promise) });
        await Promise.all(pending);
      }).finally(() => this.activations.delete(scheme));
      this.activations.set(scheme, activation);
    }
    await activation;
  }

  private async provider(resource: URI): Promise<IFileSystemProvider> {
    const current = this.getProvider(resource.scheme);
    if (current) {
      return current;
    }
    await this.activateProvider(resource.scheme);
    const provider = this.getProvider(resource.scheme);
    if (!provider) {
      throw new FileSystemProviderError(`No file system provider for scheme '${resource.scheme}'.`, Code.Unavailable);
    }
    return provider;
  }

  private queueChanges(scheme: string, changes: readonly IFileChange[]): void {
    if (!this.pendingChanges.size) {
      queueMicrotask(() => {
        const batch = [...this.pendingChanges.values()];
        this.pendingChanges.clear();
        if (batch.length) {
          this.filesChanged.fire(new FileChangesEvent(batch));
        }
      });
    }
    for (const change of changes) {
      // Some providers are registered under more than one scheme.
      if (change.resource.scheme === scheme) {
        const { authority, path, query, fragment } = change.resource;
        this.pendingChanges.set(JSON.stringify([change.type, scheme, authority, path, query, fragment]), change);
      }
    }
  }

  async stat(resource: URI): Promise<IFileStat> {
    const provider = await this.provider(resource);
    return asFileStat(resource, provider, await provider.stat(resource));
  }

  async resolve(resource: URI): Promise<IFileStat> {
    const provider = await this.provider(resource);
    const stat = asFileStat(resource, provider, await provider.stat(resource));
    if (!stat.isDirectory) {
      return stat;
    }
    const entries = await provider.readdir(resource);
    const children = await Promise.all(entries.map(async ([name]) => {
      const child = directoryEntry(resource, name);
      const metadata = await tryStat(provider, child);
      return metadata ? asFileStat(child, provider, metadata) : undefined;
    }));
    return { ...stat, children: children.filter(child => child !== undefined) };
  }

  async exists(resource: URI): Promise<boolean> {
    const provider = await this.provider(resource);
    return (await tryStat(provider, resource)) !== undefined;
  }

  async readFile(resource: URI, options?: IFileReadOptions): Promise<IFileContent> {
    return this.read(await this.provider(resource), resource, options);
  }

  private async read(provider: IFileSystemProvider, resource: URI, options?: IFileReadOptions): Promise<IFileContent> {
    const limit = options?.limits?.size;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new RangeError('File read limit must be a non-negative byte count');
    }
    options?.signal?.throwIfAborted();
    if (provider.readFileWithStat) {
      const { stat, value } = await provider.readFileWithStat(resource, options);
      options?.signal?.throwIfAborted();
      checkSize(resource, value.byteLength, limit);
      return { ...asFileStat(resource, provider, stat), value };
    }
    const stat = await provider.stat(resource);
    if (stat.type & FileType.Directory) {
      throw new FileSystemProviderError(resource.path, Code.FileIsADirectory);
    }
    checkSize(resource, stat.size, limit);
    options?.signal?.throwIfAborted();
    const value = await provider.readFile(resource, options);
    checkSize(resource, value.byteLength, limit);
    options?.signal?.throwIfAborted();
    return { ...asFileStat(resource, provider, stat), value };
  }

  async writeFile(resource: URI, content: Uint8Array, options?: IWriteFileOptions): Promise<IFileStat> {
    const provider = await this.provider(resource);
    requireWritable(provider);
    const metadata = await this.write(provider, resource, content, true, options?.etag);
    return asFileStat(resource, provider, metadata ?? await provider.stat(resource));
  }

  async createFile(
    resource: URI, content: Uint8Array = new Uint8Array(), options?: Partial<IFileOverwriteOptions>,
  ): Promise<IFileStat> {
    const provider = await this.provider(resource);
    requireWritable(provider);
    await this.runParticipants(FileOperation.CREATE, resource);
    const metadata = await this.write(provider, resource, content, options?.overwrite ?? false);
    const target = asFileStat(resource, provider, metadata ?? await provider.stat(resource));
    this.didRun.fire(new FileOperationEvent(resource, FileOperation.CREATE, target));
    return target;
  }

  private async write(
    provider: IFileSystemProvider, resource: URI, content: Uint8Array, overwrite: boolean, expectedEtag?: string,
  ): Promise<void | IStat> {
    const atomic = !!(provider.capabilities & Cap.FileAtomicWrite);
    if (expectedEtag !== undefined && !atomic) {
      const current = await tryStat(provider, resource);
      if (!current || etag(current) !== expectedEtag) {
        throw new FileOperationError(`File has been modified since it was read: ${resource.path}`,
          FileOperationResult.FILE_MODIFIED_SINCE);
      }
    }
    const createParents = !!(provider.capabilities & Cap.CreateParents);
    if (!createParents) {
      await mkdirp(provider, dirname(resource));
    }
    return provider.writeFile(resource, content, { create: true, overwrite, etag: expectedEtag, createParents });
  }

  async createFolder(resource: URI): Promise<IFileStat> {
    const provider = await this.provider(resource);
    requireWritable(provider);
    await this.runParticipants(FileOperation.CREATE, resource);
    if (provider.capabilities & Cap.CreateParents) {
      await provider.mkdir(resource, { recursive: true });
    } else {
      await mkdirp(provider, resource);
    }
    const target = asFileStat(resource, provider, await provider.stat(resource));
    this.didRun.fire(new FileOperationEvent(resource, FileOperation.CREATE, target));
    return target;
  }

  async move(source: URI, target: URI, overwrite = false): Promise<IFileStat> {
    return this.transfer(source, target, overwrite, FileOperation.MOVE);
  }

  async copy(source: URI, target: URI, overwrite = false): Promise<IFileStat> {
    return this.transfer(source, target, overwrite, FileOperation.COPY);
  }

  private async transfer(source: URI, target: URI, overwrite: boolean, operation: FileOperation): Promise<IFileStat> {
    const [origin, destination] = await Promise.all([this.provider(source), this.provider(target)]);
    const move = operation === FileOperation.MOVE;
    const sameProvider = origin === destination && source.scheme === target.scheme;
    requireWritable(destination);
    if (move) {
      requireWritable(origin);
    }
    if (sameProvider && move && source.path === target.path && isEqualOrParent(source, target)) {
      return asFileStat(target, destination, await destination.stat(target));
    }
    if (sameProvider && (isEqualOrParent(target, source) || isEqualOrParent(source, target))) {
      throw new FileSystemProviderError('Cannot transfer overlapping file trees', Code.NoPermissions);
    }
    await this.runParticipants(operation, source, target);
    if (!(destination.capabilities & Cap.CreateParents)) {
      await mkdirp(destination, dirname(target));
    }
    if (sameProvider && move) {
      await origin.rename(source, target, { overwrite });
    } else if (sameProvider && origin.copy) {
      await origin.copy(source, target, { overwrite });
    } else {
      await this.copyAcrossProviders(origin, source, destination, target, overwrite);
      if (move) {
        await origin.delete(source, { recursive: true });
      }
    }
    const stat = asFileStat(target, destination, await destination.stat(target));
    this.didRun.fire(new FileOperationEvent(source, operation, stat));
    return stat;
  }

  private async copyAcrossProviders(
    origin: IFileSystemProvider, source: URI, destination: IFileSystemProvider, target: URI, overwrite: boolean,
  ): Promise<void> {
    if (!overwrite && await tryStat(destination, target)) {
      throw new FileSystemProviderError(target.path, Code.FileExists);
    }
    const nonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-');
    const staging = joinPath(dirname(target), '.writing-room-copy-' + nonce);
    let ownsStaging = false;
    const copy = async (from: URI, to: URI): Promise<void> => {
      const stat = await origin.stat(from);
      if (stat.type & FileType.Directory) {
        if (destination.capabilities & Cap.CreateParents) {
          await destination.mkdir(to, { recursive: true });
        } else {
          await destination.mkdir(to);
        }
        ownsStaging = true;
        for (const [name] of await origin.readdir(from)) {
          await copy(directoryEntry(from, name), directoryEntry(to, name));
        }
      } else {
        const { value } = await this.read(origin, from, { limits: { size: 50 * 1024 * 1024 } });
        await this.write(destination, to, value, false);
        ownsStaging = true;
      }
    };
    try {
      await copy(source, staging);
      await destination.rename(staging, target, { overwrite });
    } catch (error) {
      if (ownsStaging) {
        try {
          await destination.delete(staging, { recursive: true });
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Unable to copy the file and remove its staged data');
        }
      }
      throw error;
    }
  }

  async del(resource: URI, options?: Partial<IFileDeleteOptions>): Promise<void> {
    const provider = await this.provider(resource);
    requireWritable(provider);
    await this.runParticipants(FileOperation.DELETE, resource);
    await provider.delete(resource, { recursive: options?.recursive ?? false });
    this.didRun.fire(new FileOperationEvent(resource, FileOperation.DELETE));
  }

  watch(resource: URI, options?: Partial<IWatchOptions>): IDisposable {
    let subscription: IDisposable | undefined;
    let disposed = false;
    const start = (provider: IFileSystemProvider) => {
      if (!disposed) {
        subscription = provider.watch(resource, { recursive: false, ...options });
      }
    };
    const existing = this.getProvider(resource.scheme);
    if (existing) {
      start(existing);
    } else {
      void this.provider(resource).then(start).catch(error => {
        if (!disposed) {
          this.watchError.fire(error);
        }
      });
    }
    return toDisposable(() => {
      disposed = true;
      subscription?.dispose();
    });
  }

  private async runParticipants(operation: FileOperation, resource: URI, target?: URI): Promise<void> {
    const pending: PromiseLike<unknown>[] = [];
    let accepting = true;
    this.willRun.fire({ operation, resource, target, waitUntil(promise) {
      if (!accepting) {
        throw new Error('waitUntil must be called during the file operation event');
      }
      pending.push(promise);
    } });
    accepting = false;
    await Promise.all(pending);
  }
}

function requireWritable(provider: IFileSystemProvider): void {
  if (provider.capabilities & Cap.Readonly) {
    throw new FileSystemProviderError('File system is read-only', Code.NoPermissions);
  }
}

async function tryStat(provider: IFileSystemProvider, resource: URI): Promise<IStat | undefined> {
  try {
    return await provider.stat(resource);
  } catch (error) {
    if (toFileSystemProviderErrorCode(error) !== Code.FileNotFound) {
      throw error;
    }
  }
}

async function mkdirp(provider: IFileSystemProvider, resource: URI): Promise<void> {
  const missing: URI[] = [];
  for (let current = resource; ; current = dirname(current)) {
    const stat = await tryStat(provider, current);
    if (stat) {
      if (!(stat.type & FileType.Directory)) {
        throw new FileSystemProviderError(current.path, Code.FileNotADirectory);
      }
      break;
    }
    missing.push(current);
    if (dirname(current).path === current.path) {
      break;
    }
  }
  for (const folder of missing.reverse()) {
    try {
      await provider.mkdir(folder);
    } catch (error) {
      if (toFileSystemProviderErrorCode(error) !== Code.FileExists) {
        throw error;
      }
      if (!((await provider.stat(folder)).type & FileType.Directory)) {
        throw new FileSystemProviderError(folder.path, Code.FileNotADirectory);
      }
    }
  }
}

function directoryEntry(parent: URI, name: string): URI {
  if (!name || name === '.' || name === '..' || name.includes('/')) {
    throw new FileSystemProviderError('Invalid directory entry name', Code.NoPermissions);
  }
  return joinPath(parent, name);
}

function asFileStat(resource: URI, provider: IFileSystemProvider, stat: IStat): IFileStat {
  return {
    ...stat, resource, name: basename(resource), etag: etag(stat),
    isFile: !!(stat.type & FileType.File), isDirectory: !!(stat.type & FileType.Directory),
    isSymbolicLink: !!(stat.type & FileType.SymbolicLink), readonly: !!(provider.capabilities & Cap.Readonly),
  };
}

function checkSize(resource: URI, size: number, limit: number | undefined): void {
  if (limit !== undefined && size > limit) {
    throw new FileSystemProviderError(`File exceeds ${limit} bytes: ${resource.path}`, Code.FileTooLarge);
  }
}
