import type * as vscode from 'vscode';
import { raceCancellation } from '../../../base/common/async.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { dispose, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { TransferableBuffer } from '../../../base/common/marshalling.js';
import { URI } from '../../../base/common/uri.js';
import {
  FileChangeType as ProviderChange, FileSystemProviderCapabilities, FileSystemProviderError,
  FileSystemProviderErrorCode, toFileSystemProviderErrorCode,
} from '../../../platform/files/common/files.js';
import type { IFileChange, IFileDeleteOptions, IFileOverwriteOptions, IFileWriteOptions, IWatchOptions } from '../../../platform/files/common/files.js';
import type { FileStatDto, MainThreadFileSystemShape } from './extHost.protocol.fileSystem.js';
import { fileProviderDirectory, fileProviderStat } from './extHostFileSystemProviderData.js';
import { duplicateProvider, validateExtensionFileSystemScheme } from './extHostFileSystemSchemes.js';

export enum FileChangeType {
  Changed = 1,
  Created = 2,
  Deleted = 3,
}

const changeTypes = new Map<number, ProviderChange>([
  [FileChangeType.Changed, ProviderChange.UPDATED],
  [FileChangeType.Created, ProviderChange.ADDED],
  [FileChangeType.Deleted, ProviderChange.DELETED],
]);
const requiredMethods = ['watch', 'stat', 'readDirectory', 'createDirectory', 'readFile', 'writeFile', 'delete', 'rename', 'onDidChangeFile'] as const;
const Cap = FileSystemProviderCapabilities;
const Code = FileSystemProviderErrorCode;

interface Entry {
  readonly extension: string;
  readonly scheme: string;
  readonly provider: vscode.FileSystemProvider;
  readonly lifetime: CancellationTokenSource;
  readonly disposables: DisposableStore;
  readonly watches: Map<number, IDisposable>;
  readonly capabilities: FileSystemProviderCapabilities;
  readonly registration: IDisposable;
}

function unavailable(): FileSystemProviderError {
  return new FileSystemProviderError('The extension file system provider is no longer running.', Code.Unavailable);
}

export class ExtHostFileSystemProvider {
  private readonly providers = new Map<number, Entry>();
  private readonly schemes = new Map<string, Entry>();
  private nextHandle = 0;

  constructor(
    private readonly proxy: MainThreadFileSystemShape,
    private readonly getExternalCapability: (scheme: string) => FileSystemProviderCapabilities | undefined,
  ) {}

  getCapabilities(scheme: string): FileSystemProviderCapabilities | undefined {
    return this.schemes.get(scheme)?.capabilities;
  }

  register(extension: string, scheme: string, provider: vscode.FileSystemProvider,
    options?: { readonly isCaseSensitive?: boolean; readonly isReadonly?: boolean | vscode.MarkdownString },
  ): vscode.Disposable {
    validateExtensionFileSystemScheme(scheme);
    const name = scheme.toLowerCase();
    if (this.schemes.has(name) || this.getExternalCapability(name) !== undefined) {
      throw duplicateProvider(name);
    }
    for (const method of requiredMethods) {
      if (typeof provider?.[method] !== 'function') {
        throw new Error(`FileSystemProvider.${method} must be a function.`);
      }
    }
    const capabilities = Cap.FileReadWrite
      | (options?.isCaseSensitive ? Cap.PathCaseSensitive : 0)
      | (options?.isReadonly ? Cap.Readonly : 0)
      | (typeof provider.copy === 'function' ? Cap.FileFolderCopy : 0);
    const handle = this.nextHandle++;
    const lifetime = new CancellationTokenSource();
    const disposables = new DisposableStore();
    const registration = toDisposable(() => {
      this.providers.delete(handle);
      this.schemes.delete(name);
      lifetime.dispose(true);
      try {
        disposables.dispose();
      } finally {
        entry.watches.clear();
        void this.proxy.$unregisterFileSystemProvider(extension, handle).catch(() => {});
      }
    });
    const entry: Entry = { extension, scheme: name, provider, lifetime, disposables, watches: new Map(), capabilities, registration };
    this.providers.set(handle, entry);
    this.schemes.set(name, entry);
    void this.proxy.$registerFileSystemProvider(extension, handle, name, capabilities)
      .catch(() => registration.dispose()).catch(error => console.error(error));
    try {
      disposables.add(provider.onDidChangeFile(events => {
        const changes: IFileChange[] = [];
        for (const event of Array.isArray(events) ? events : []) {
          if (!event) {
            continue;
          }
          const { type, uri } = event;
          const platformType = changeTypes.get(type);
          if (platformType !== undefined && URI.isUri(uri) && uri.scheme === name) {
            changes.push({ type: platformType, resource: uri });
          }
        }
        if (changes.length) {
          void this.proxy.$onProviderFileChanges(extension, handle, changes).catch(() => {});
        }
      }));
    } catch (error) {
      registration.dispose();
      throw error;
    }
    return registration;
  }

  async $providerStat(extension: string, handle: number, resource: URI, token: CancellationToken): Promise<FileStatDto> {
    const stat = await this.run(extension, handle, token, provider => provider.stat(resource));
    return fileProviderStat(stat);
  }

  async $providerReadDirectory(extension: string, handle: number, resource: URI, token: CancellationToken) {
    return fileProviderDirectory(await this.run(extension, handle, token, provider => provider.readDirectory(resource)));
  }

  async $providerReadFile(extension: string, handle: number, resource: URI, limit: number | undefined, token: CancellationToken) {
    const content = await this.run(extension, handle, token, provider => provider.readFile(resource));
    if (!(content instanceof Uint8Array)) {
      throw new FileSystemProviderError('Invalid file contents from the extension provider.', Code.Unknown);
    }
    if (limit !== undefined && content.byteLength > limit) {
      throw new FileSystemProviderError('File is too large.', Code.FileTooLarge);
    }
    // A provider may return a view of storage it still owns.
    return new TransferableBuffer(new Uint8Array(content));
  }

  $providerCreateDirectory(extension: string, handle: number, resource: URI, token: CancellationToken) {
    return this.run(extension, handle, token, provider => provider.createDirectory(resource));
  }

  async $providerWriteFile(extension: string, handle: number, resource: URI, bytes: Uint8Array | TransferableBuffer,
    options: IFileWriteOptions, token: CancellationToken,
  ): Promise<void> {
    if (!(bytes instanceof Uint8Array)) {
      throw new FileSystemProviderError('Expected file contents as Uint8Array.', Code.Unknown);
    }
    await this.run(extension, handle, token, provider => provider.writeFile(resource, bytes, options));
  }

  $providerDelete(extension: string, handle: number, resource: URI, options: IFileDeleteOptions, token: CancellationToken) {
    return this.run(extension, handle, token, provider => provider.delete(resource, options));
  }

  $providerRename(extension: string, handle: number, from: URI, to: URI, options: IFileOverwriteOptions, token: CancellationToken) {
    return this.run(extension, handle, token, provider => provider.rename(from, to, options));
  }

  $providerCopy(extension: string, handle: number, from: URI, to: URI, options: IFileOverwriteOptions, token: CancellationToken) {
    return this.run(extension, handle, token, provider => {
      if (!provider.copy) {
        throw unavailable();
      }
      return provider.copy(from, to, options);
    });
  }

  async $providerWatch(extension: string, handle: number, watch: number, resource: URI, options: IWatchOptions): Promise<void> {
    const entry = this.get(extension, handle);
    if (entry.watches.has(watch)) {
      throw new Error('Provider watch is already registered.');
    }
    const subscription = entry.provider.watch(resource, { recursive: options.recursive, excludes: options.excludes ?? [] });
    entry.watches.set(watch, entry.disposables.add(subscription));
  }

  async $providerUnwatch(extension: string, handle: number, watch: number): Promise<void> {
    const entry = this.providers.get(handle);
    const subscription = entry?.extension === extension ? entry.watches.get(watch) : undefined;
    if (entry && subscription) {
      entry.watches.delete(watch);
      entry.disposables.delete(subscription);
    }
  }

  private get(extension: string, handle: number): Entry {
    const entry = this.providers.get(handle);
    if (entry?.extension !== extension) {
      throw unavailable();
    }
    return entry;
  }

  private async run<T>(extension: string, handle: number, token: CancellationToken,
    invoke: (provider: vscode.FileSystemProvider) => T | PromiseLike<T>,
  ): Promise<T> {
    const entry = this.get(extension, handle);
    const source = new CancellationTokenSource(entry.lifetime.token);
    const listener = token.onCancellationRequested(() => source.cancel());
    try {
      if (token.isCancellationRequested || source.token.isCancellationRequested) {
        throw unavailable();
      }
      const result = await raceCancellation(Promise.resolve(invoke(entry.provider)), source.token);
      if (source.token.isCancellationRequested) {
        throw unavailable();
      }
      return result as T;
    } catch (error) {
      throw new FileSystemProviderError(error instanceof Error ? error.message : String(error), toFileSystemProviderErrorCode(error));
    } finally {
      listener.dispose();
      source.dispose();
    }
  }

  release(extension: string): void {
    dispose([...this.providers.values()].filter(entry => entry.extension === extension).map(entry => entry.registration));
  }

  dispose(): void {
    dispose([...this.providers.values()].map(entry => entry.registration));
  }
}
