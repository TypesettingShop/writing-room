import { Disposable } from '../../../base/common/lifecycle.js';
import { TransferableBuffer } from '../../../base/common/marshalling.js';
import { Schemas } from '../../../base/common/network.js';
import { dirname } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import {
  FileSystemProviderCapabilities, FileSystemProviderError, FileSystemProviderErrorCode, IFileService,
} from '../../../platform/files/common/files.js';
import type { IFileSystemProvider } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { ExtHostFileSystemProxy, MainThreadFileSystemProxy } from '../common/extHost.protocol.fileSystem.js';
import type {
  ExtHostFileSystemShape, FileStatDto, FileSystemCapabilityDto, MainThreadFileSystemShape, WorkspaceFolderDto,
} from '../common/extHost.protocol.fileSystem.js';
import { ExtensionFileAccess } from './extensionFileAccess.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { MainThreadWorkspace } from './mainThreadWorkspace.js';

const maxReadBytes = 50 * 1024 * 1024;
const Code = FileSystemProviderErrorCode;
const knownSchemes = Object.values(Schemas);

export class MainThreadFileSystem extends Disposable implements MainThreadFileSystemShape {
  private readonly workspace: MainThreadWorkspace;
  private readonly access: ExtensionFileAccess;

  constructor(
    private readonly proxy: ExtHostFileSystemShape,
    private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
    private readonly files: IFileService,
    context: IWorkspaceContextService,
    extensions: IExtensionService,
  ) {
    super();
    this.workspace = new MainThreadWorkspace(context);
    this.access = new ExtensionFileAccess(context.getWorkspace(),
      () => extensions.extensions?.map(extension => extension.location) ?? [], () => false);
    this._register(files.onDidChangeFileSystemProviderRegistrations(({ scheme, added, provider }) => {
      void proxy.$acceptFileSystemCapability(scheme, added ? provider?.capabilities : undefined).catch(() => {});
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

  private resource(extension: string, resource: URI, write = false): URI {
    const owner = typeof extension === 'string' ? this.getExtension(extension) : undefined;
    if (!owner) {
      throw new FileSystemProviderError('The extension is not registered.', Code.NoPermissions);
    }
    return this.access.require(owner, resource, write);
  }

  private provider(resource: URI): IFileSystemProvider {
    const provider = this.files.getProvider(resource.scheme);
    if (!provider) {
      throw new FileSystemProviderError(`No file system provider for scheme '${resource.scheme}'.`, Code.Unavailable);
    }
    return provider;
  }

  async $stat(extension: string, resource: URI): Promise<FileStatDto> {
    const { type, ctime, mtime, size, readonly } = await this.files.stat(this.resource(extension, resource));
    return { type, ctime, mtime, size, ...(readonly ? { permissions: 1 } : {}) };
  }

  async $readDirectory(extension: string, resource: URI) {
    const uri = this.resource(extension, resource);
    return this.provider(uri).readdir(uri);
  }

  async $createDirectory(extension: string, resource: URI): Promise<void> {
    await this.files.createFolder(this.resource(extension, resource, true));
  }

  async $readFile(extension: string, resource: URI): Promise<TransferableBuffer> {
    const { value } = await this.files.readFile(this.resource(extension, resource), { limits: { size: maxReadBytes } });
    return new TransferableBuffer(value);
  }

  async $writeFile(extension: string, resource: URI, content: TransferableBuffer | Uint8Array): Promise<void> {
    const uri = this.resource(extension, resource, true);
    if (!(content instanceof Uint8Array)) {
      throw new TypeError('Expected file contents as Uint8Array.');
    }
    await this.files.writeFile(uri, content);
  }

  async $delete(extension: string, resource: URI, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    await this.files.del(this.resource(extension, resource, true), { recursive: options?.recursive === true });
  }

  async $rename(extension: string, source: URI, target: URI, options?: { overwrite?: boolean }): Promise<void> {
    const from = this.resource(extension, source, true);
    const to = this.resource(extension, target, true);
    if (from.scheme !== to.scheme) {
      this.resource(extension, dirname(to), true);
    }
    await this.files.move(from, to, options?.overwrite === true);
  }

  async $copy(extension: string, source: URI, target: URI, options?: { overwrite?: boolean }): Promise<void> {
    const from = this.resource(extension, source);
    const to = this.resource(extension, target, true);
    // The file service stages a fallback copy next to the target.
    if (from.scheme !== to.scheme || !this.provider(from).copy) {
      this.resource(extension, dirname(to), true);
    }
    await this.files.copy(from, to, options?.overwrite === true);
  }
}

mainThreadCustomers.register('fileSystem', ({ rpc, instantiation, getExtension }) =>
  instantiation.invokeFunction(accessor => {
    const main = new MainThreadFileSystem(rpc.getProxy(ExtHostFileSystemProxy), getExtension,
      accessor.get(IFileService), accessor.get(IWorkspaceContextService), accessor.get(IExtensionService));
    rpc.set(MainThreadFileSystemProxy, main);
    return main;
  }));
