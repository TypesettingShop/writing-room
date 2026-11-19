import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { TransferableBuffer } from '../../../base/common/marshalling.js';
import { Schemas } from '../../../base/common/network.js';
import { dirname } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import {
  FileChangeType, FileSystemProviderCapabilities, FileSystemProviderError, FileSystemProviderErrorCode, IFileService,
} from '../../../platform/files/common/files.js';
import type { IFileChange, IFileSystemProvider } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { ExtHostFileSystemProviderProxy, ExtHostFileSystemProxy, MainThreadFileSystemProxy } from '../common/extHost.protocol.fileSystem.js';
import type {
  ExtHostFileSystemProviderShape, ExtHostFileSystemShape, FileGlobDto, FileOperationSubscription, FileStatDto, FileSystemCapabilityDto,
  MainThreadFileSystemShape, WorkspaceFolderDto,
} from '../common/extHost.protocol.fileSystem.js';
import { duplicateProvider, validateExtensionFileSystemScheme } from '../common/extHostFileSystemSchemes.js';
import { ExtensionFileAccess, normalizeExtensionFileResource } from './extensionFileAccess.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { MainThreadFileSystemEventService } from './mainThreadFileSystemEventService.js';
import { fileSystemActivationEvent } from './mainThreadFileSystemActivation.js';
import { MainThreadFileSystemProvider } from './mainThreadFileSystemProvider.js';
import { MainThreadWorkspace } from './mainThreadWorkspace.js';

const maxReadBytes = 50 * 1024 * 1024;
const Code = FileSystemProviderErrorCode;
const Cap = FileSystemProviderCapabilities;
const knownSchemes = Object.values(Schemas);
const allowedCapabilities = Cap.FileReadWrite | Cap.FileFolderCopy | Cap.PathCaseSensitive | Cap.Readonly;

interface ProviderRegistration {
  readonly provider: MainThreadFileSystemProvider;
  readonly scheme: string;
  readonly registration: IDisposable;
}

export class MainThreadFileSystem extends Disposable implements MainThreadFileSystemShape {
  private readonly workspace: MainThreadWorkspace;
  private readonly events: MainThreadFileSystemEventService;
  private readonly access: ExtensionFileAccess;
  private readonly providers = new Map<number, ProviderRegistration>();
  private readonly schemeOwners = new Map<string, MainThreadFileSystemProvider>();
  private readonly recentlyRemoved = new Set<string>();
  private stopped = false;

  constructor(
    proxy: ExtHostFileSystemShape,
    private readonly providerProxy: ExtHostFileSystemProviderShape,
    private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
    private readonly files: IFileService,
    context: IWorkspaceContextService,
    private readonly extensions: IExtensionService,
    private readonly activate: (event: string, origin: string) => Promise<void>,
  ) {
    super();
    this.workspace = new MainThreadWorkspace(context, files);
    this.access = new ExtensionFileAccess(context.getWorkspace(),
      () => extensions.extensions?.map(extension => extension.location) ?? [], scheme => this.schemeOwners.has(scheme));
    this.events = this._register(new MainThreadFileSystemEventService(files, proxy, this.access, getExtension,
      this.workspace.folders.map(folder => folder.uri)));
    this._register(files.onDidChangeFileSystemProviderRegistrations(({ scheme, added, provider }) => {
      if (!(provider instanceof MainThreadFileSystemProvider)) {
        void proxy.$acceptFileSystemCapability(scheme, added ? provider?.capabilities : undefined).catch(() => {});
      }
    }));
  }

  async $initializeFileSystem(): Promise<{
    folders: readonly WorkspaceFolderDto[];
    capabilities: FileSystemCapabilityDto[];
  }> {
    const capabilities: FileSystemCapabilityDto[] = [];
    for (const scheme of knownSchemes) {
      const provider = this.files.getProvider(scheme);
      if (provider) {
        capabilities.push([scheme, provider.capabilities]);
      }
    }
    return { folders: this.workspace.folders, capabilities };
  }

  private extension(extension: string): HostExtensionDescription {
    const owner = !this.stopped && typeof extension === 'string' ? this.getExtension(extension) : undefined;
    if (!owner) {
      throw new FileSystemProviderError('The extension is not registered.', Code.NoPermissions);
    }
    return owner;
  }

  private async resource(extension: string, resource: URI, write = false): Promise<URI> {
    const owner = this.extension(extension);
    const uri = normalizeExtensionFileResource(resource);
    const scheme = uri.scheme;
    if (!this.schemeOwners.has(scheme)) {
      const event = fileSystemActivationEvent(this.extensions, uri.scheme);
      if (event) {
        // The originating extension is already running. The activation graph detects a cycle
        // if an activation reaches back into the same scheme.
        await this.activate(event, extension).catch(() => {});
        this.extension(extension);
      }
      if ((event || this.recentlyRemoved.has(uri.scheme)) && !this.schemeOwners.has(scheme)) {
        throw new FileSystemProviderError(`No file system provider for scheme '${uri.scheme}'.`, Code.Unavailable);
      }
    }
    if (!this.access.isAllowed(owner, uri, write)) {
      throw new FileSystemProviderError('Access to this file resource is denied.', Code.NoPermissions);
    }
    return uri;
  }

  async $registerFileSystemProvider(extension: string, handle: number, scheme: string, capabilities: FileSystemProviderCapabilities): Promise<void> {
    this.extension(extension);
    validateExtensionFileSystemScheme(scheme);
    if (scheme !== scheme.toLowerCase() || !Number.isSafeInteger(handle) || handle < 0
      || !Number.isSafeInteger(capabilities) || capabilities < 0 || capabilities > allowedCapabilities
      || (capabilities & ~allowedCapabilities) !== 0 || !(capabilities & Cap.FileReadWrite)) {
      throw new TypeError('Invalid extension file system provider metadata.');
    }
    if (this.providers.has(handle) || this.files.getProvider(scheme)) {
      throw duplicateProvider(scheme);
    }
    const provider = new MainThreadFileSystemProvider(extension, handle, capabilities, this.providerProxy);
    const registration = this.files.registerProvider(scheme, provider);
    this.providers.set(handle, { provider, scheme, registration });
    this.schemeOwners.set(scheme, provider);
    this.recentlyRemoved.delete(scheme);
  }

  async $unregisterFileSystemProvider(extension: string, handle: number): Promise<void> {
    const entry = this.providers.get(handle);
    if (entry?.provider.extension === extension) {
      this.unregisterProvider(handle, entry);
    }
  }

  async $onProviderFileChanges(extension: string, handle: number, changes: readonly IFileChange[]): Promise<void> {
    this.extension(extension);
    const entry = this.providers.get(handle);
    if (entry?.provider.extension !== extension || !Array.isArray(changes)) {
      return;
    }
    const accepted: IFileChange[] = [];
    for (const change of changes) {
      if (!change || !URI.isUri(change.resource) || change.resource.scheme !== entry.scheme
        || ![FileChangeType.ADDED, FileChangeType.UPDATED, FileChangeType.DELETED].includes(change.type)) {
        continue;
      }
      try {
        accepted.push({ type: change.type, resource: normalizeExtensionFileResource(change.resource) });
      } catch {
        // Malformed resources do not become workbench or watcher events.
      }
    }
    if (accepted.length) {
      entry.provider.acceptChanges(accepted);
    }
  }

  private unregisterProvider(handle: number, { provider, scheme, registration }: ProviderRegistration): void {
    this.providers.delete(handle);
    this.schemeOwners.delete(scheme);
    this.recentlyRemoved.add(scheme);
    if (this.recentlyRemoved.size > 256) {
      const oldest = this.recentlyRemoved.values().next().value;
      if (oldest !== undefined) {
        this.recentlyRemoved.delete(oldest);
      }
    }
    registration.dispose();
    provider.dispose();
  }

  async $watch(extension: string, handle: number, base?: URI): Promise<void> {
    await this.events.watch(this.extension(extension), handle, base === undefined ? undefined : () => this.resource(extension, base));
  }

  async $unwatch(extension: string, handle: number): Promise<void> {
    this.events.unwatch(extension, handle);
  }

  async $subscribeFileOperation(extension: string, event: FileOperationSubscription, enabled: boolean): Promise<void> {
    this.extension(extension);
    this.events.subscribe(extension, event, enabled);
  }

  $findFiles(extension: string, include: FileGlobDto, exclude?: FileGlobDto | null,
    maxResults?: number, token?: CancellationToken): Promise<URI[]> {
    this.extension(extension);
    return this.workspace.findFiles(include, exclude, maxResults, token);
  }

  remove(extension: string): void {
    this.events.remove(extension);
    for (const [handle, entry] of this.providers) {
      if (entry.provider.extension === extension) {
        this.unregisterProvider(handle, entry);
      }
    }
  }

  override dispose(): void {
    this.stopped = true;
    super.dispose();
    for (const [handle, entry] of this.providers) {
      this.unregisterProvider(handle, entry);
    }
    this.recentlyRemoved.clear();
  }

  private provider(resource: URI): IFileSystemProvider {
    const provider = this.files.getProvider(resource.scheme);
    if (!provider) {
      throw new FileSystemProviderError(`No file system provider for scheme '${resource.scheme}'.`, Code.Unavailable);
    }
    return provider;
  }

  async $stat(extension: string, resource: URI): Promise<FileStatDto> {
    const stat = await this.files.stat(await this.resource(extension, resource));
    const { type, ctime, mtime, size } = stat;
    const readonly = stat.readonly || ('permissions' in stat && stat.permissions === 1);
    return { type, ctime, mtime, size, ...(readonly ? { permissions: 1 } : {}) };
  }

  async $readDirectory(extension: string, resource: URI) {
    const uri = await this.resource(extension, resource);
    return this.provider(uri).readdir(uri);
  }

  async $createDirectory(extension: string, resource: URI): Promise<void> {
    await this.files.createFolder(await this.resource(extension, resource, true));
  }

  async $readFile(extension: string, resource: URI): Promise<TransferableBuffer> {
    const { value } = await this.files.readFile(await this.resource(extension, resource), { limits: { size: maxReadBytes } });
    return new TransferableBuffer(value);
  }

  async $writeFile(extension: string, resource: URI, content: TransferableBuffer | Uint8Array): Promise<void> {
    const uri = await this.resource(extension, resource, true);
    if (!(content instanceof Uint8Array)) {
      throw new TypeError('Expected file contents as Uint8Array.');
    }
    await this.files.writeFile(uri, content);
  }

  async $delete(extension: string, resource: URI, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    await this.files.del(await this.resource(extension, resource, true), { recursive: options?.recursive === true });
  }

  async $rename(extension: string, source: URI, target: URI, options?: { overwrite?: boolean }): Promise<void> {
    const from = await this.resource(extension, source, true);
    const to = await this.resource(extension, target, true);
    if (from.scheme !== to.scheme) {
      this.access.require(this.extension(extension), dirname(to), true);
    }
    await this.files.move(from, to, options?.overwrite === true);
  }

  async $copy(extension: string, source: URI, target: URI, options?: { overwrite?: boolean }): Promise<void> {
    const from = await this.resource(extension, source);
    const to = await this.resource(extension, target, true);
    // The file service stages a fallback copy next to the target.
    if (from.scheme !== to.scheme || !this.provider(from).copy) {
      this.access.require(this.extension(extension), dirname(to), true);
    }
    await this.files.copy(from, to, options?.overwrite === true);
  }
}

mainThreadCustomers.register('fileSystem', ({ rpc, instantiation, getExtension, activate }) =>
  instantiation.invokeFunction(accessor => {
    const main = new MainThreadFileSystem(rpc.getProxy(ExtHostFileSystemProxy), rpc.getProxy(ExtHostFileSystemProviderProxy), getExtension,
      accessor.get(IFileService), accessor.get(IWorkspaceContextService), accessor.get(IExtensionService), activate);
    rpc.set(MainThreadFileSystemProxy, main);
    return main;
  }));
