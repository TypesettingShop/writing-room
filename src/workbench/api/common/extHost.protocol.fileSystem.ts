import type { TransferableBuffer } from '../../../base/common/marshalling.js';
import type { URI } from '../../../base/common/uri.js';
import type { FileSystemProviderCapabilities, FileType, IStat } from '../../../platform/files/common/files.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

export interface WorkspaceFolderDto {
  readonly uri: URI;
  readonly name: string;
  readonly index: number;
}

export type FileStatDto = IStat & { readonly permissions?: 1 };
export type FileSystemCapabilityDto = readonly [scheme: string, capabilities: FileSystemProviderCapabilities];

export interface MainThreadFileSystemShape {
  $initializeFileSystem(): Promise<{
    readonly folders: readonly WorkspaceFolderDto[];
    readonly capabilities: readonly FileSystemCapabilityDto[];
  }>;
  $stat(extension: string, resource: URI): Promise<FileStatDto>;
  $readDirectory(extension: string, resource: URI): Promise<readonly [string, FileType][]>;
  $createDirectory(extension: string, resource: URI): Promise<void>;
  $readFile(extension: string, resource: URI): Promise<TransferableBuffer | Uint8Array>;
  $writeFile(extension: string, resource: URI, content: TransferableBuffer | Uint8Array): Promise<void>;
  $delete(extension: string, resource: URI, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void>;
  $rename(extension: string, source: URI, target: URI, options?: { overwrite?: boolean }): Promise<void>;
  $copy(extension: string, source: URI, target: URI, options?: { overwrite?: boolean }): Promise<void>;
}

export interface ExtHostFileSystemShape {
  $acceptFileSystemCapability(scheme: string, capabilities: FileSystemProviderCapabilities | undefined): Promise<void>;
}

export const MainThreadFileSystemProxy = createProxyIdentifier<MainThreadFileSystemShape>('MainThreadFileSystem');
export const ExtHostFileSystemProxy = createProxyIdentifier<ExtHostFileSystemShape>('ExtHostFileSystem');
