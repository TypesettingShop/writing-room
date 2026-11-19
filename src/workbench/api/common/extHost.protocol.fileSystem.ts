import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { TransferableBuffer } from '../../../base/common/marshalling.js';
import type { URI } from '../../../base/common/uri.js';
import type { FileSystemProviderCapabilities, FileType, IFileChange, IFileDeleteOptions, IFileOverwriteOptions, IFileWriteOptions, IStat, IWatchOptions } from '../../../platform/files/common/files.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

export interface WorkspaceFolderDto {
  readonly uri: URI;
  readonly name: string;
  readonly index: number;
}

export type FileStatDto = IStat & { readonly permissions?: 1 };
export type FileSystemCapabilityDto = readonly [scheme: string, capabilities: FileSystemProviderCapabilities];

export type FileGlobDto = string | { readonly base: URI; readonly pattern: string };
export type FileOperationKind = 'create' | 'delete' | 'rename';
export type FileOperationSubscription = `did:${FileOperationKind}` | `will:${FileOperationKind}`;

export type FileOperationDto =
  | { readonly kind: 'create' | 'delete'; readonly resource: URI }
  | { readonly kind: 'rename'; readonly resource: URI; readonly target: URI };

export interface FileWatcherBatch {
  readonly extension: string;
  readonly handles: readonly number[];
  readonly changes: readonly IFileChange[];
}

export interface MainThreadFileSystemShape {
  $initializeFileSystem(): Promise<{
    readonly folders: readonly WorkspaceFolderDto[];
    readonly capabilities: readonly FileSystemCapabilityDto[];
  }>;
  $registerFileSystemProvider(extension: string, handle: number, scheme: string, capabilities: FileSystemProviderCapabilities): Promise<void>;
  $unregisterFileSystemProvider(extension: string, handle: number): Promise<void>;
  $onProviderFileChanges(extension: string, handle: number, changes: readonly IFileChange[]): Promise<void>;
  $watch(extension: string, handle: number, base?: URI): Promise<void>;
  $unwatch(extension: string, handle: number): Promise<void>;
  $subscribeFileOperation(extension: string, event: FileOperationSubscription, enabled: boolean): Promise<void>;
  $findFiles(extension: string, include: FileGlobDto, exclude?: FileGlobDto | null,
    maxResults?: number, token?: CancellationToken): Promise<URI[]>;
  $stat(extension: string, resource: URI): Promise<FileStatDto>;
  $readDirectory(extension: string, resource: URI): Promise<readonly [string, FileType][]>;
  $createDirectory(extension: string, resource: URI): Promise<void>;
  $readFile(extension: string, resource: URI): Promise<TransferableBuffer | Uint8Array>;
  $writeFile(extension: string, resource: URI, content: TransferableBuffer | Uint8Array): Promise<void>;
  $delete(extension: string, resource: URI, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void>;
  $rename(extension: string, source: URI, target: URI, options?: { overwrite?: boolean }): Promise<void>;
  $copy(extension: string, source: URI, target: URI, options?: { overwrite?: boolean }): Promise<void>;
}

export interface ExtHostFileSystemProviderShape {
  $providerStat(extension: string, handle: number, resource: URI, token: CancellationToken): Promise<FileStatDto>;
  $providerReadDirectory(extension: string, handle: number, resource: URI, token: CancellationToken): Promise<readonly [string, FileType][]>;
  $providerCreateDirectory(extension: string, handle: number, resource: URI, token: CancellationToken): Promise<void>;
  $providerReadFile(extension: string, handle: number, resource: URI, limit: number | undefined,
    token: CancellationToken): Promise<TransferableBuffer | Uint8Array>;
  $providerWriteFile(extension: string, handle: number, resource: URI, content: TransferableBuffer | Uint8Array,
    options: IFileWriteOptions, token: CancellationToken): Promise<void>;
  $providerDelete(extension: string, handle: number, resource: URI, options: IFileDeleteOptions,
    token: CancellationToken): Promise<void>;
  $providerRename(extension: string, handle: number, source: URI, target: URI, options: IFileOverwriteOptions,
    token: CancellationToken): Promise<void>;
  $providerCopy(extension: string, handle: number, source: URI, target: URI, options: IFileOverwriteOptions,
    token: CancellationToken): Promise<void>;
  $providerWatch(extension: string, handle: number, watch: number, resource: URI, options: IWatchOptions): Promise<void>;
  $providerUnwatch(extension: string, handle: number, watch: number): Promise<void>;
}

export interface ExtHostFileSystemShape {
  $acceptFileChanges(batches: readonly FileWatcherBatch[]): Promise<void>;
  $acceptFileOperation(extensions: readonly string[], event: FileOperationDto): Promise<void>;
  $participateInFileOperation(extensions: readonly string[], event: FileOperationDto, token: CancellationToken): Promise<void>;
  $acceptFileSystemCapability(scheme: string, capabilities: FileSystemProviderCapabilities | undefined): Promise<void>;
}

export const MainThreadFileSystemProxy = createProxyIdentifier<MainThreadFileSystemShape>('MainThreadFileSystem');
export const ExtHostFileSystemProxy = createProxyIdentifier<ExtHostFileSystemShape>('ExtHostFileSystem');
export const ExtHostFileSystemProviderProxy = createProxyIdentifier<ExtHostFileSystemProviderShape>('ExtHostFileSystemProvider');
