import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { isEqual, isEqualOrParent } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum FileSystemProviderCapabilities {
  None = 0,
  FileReadWrite = 1 << 1,
  FileFolderCopy = 1 << 3,
  PathCaseSensitive = 1 << 10,
  Readonly = 1 << 11,
  FileAtomicWrite = 1 << 15,
  // An atomic write or mkdir can create every missing parent.
  CreateParents = 1 << 20,
}

export enum FileSystemProviderErrorCode {
  FileExists = 'EntryExists',
  FileNotFound = 'EntryNotFound',
  FileNotADirectory = 'EntryNotADirectory',
  FileIsADirectory = 'EntryIsADirectory',
  FileExceedsStorageQuota = 'EntryExceedsStorageQuota',
  FileTooLarge = 'EntryTooLarge',
  FileWriteLocked = 'EntryWriteLocked',
  NoPermissions = 'NoPermissions',
  Unavailable = 'Unavailable',
  Unknown = 'Unknown',
}

export class FileSystemProviderError extends Error {
  constructor(message: string, readonly code: FileSystemProviderErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = `${code} (FileSystemError)`;
  }
}

export function createFileSystemProviderError(
  error: Error | string, code: FileSystemProviderErrorCode,
): FileSystemProviderError {
  return new FileSystemProviderError(typeof error === 'string' ? error : error.message, code,
    typeof error === 'string' ? undefined : { cause: error });
}

export function toFileSystemProviderErrorCode(error: unknown): FileSystemProviderErrorCode {
  if (error instanceof FileSystemProviderError) {
    return error.code;
  }
  if (error instanceof Error) {
    const code = /^(.+) \(FileSystemError\)$/.exec(error.name)?.[1];
    if (Object.values(FileSystemProviderErrorCode).some(value => value === code)) {
      return code as FileSystemProviderErrorCode;
    }
  }
  return FileSystemProviderErrorCode.Unknown;
}

export enum FileOperationResult {
  FILE_IS_DIRECTORY,
  FILE_NOT_FOUND,
  FILE_NOT_MODIFIED_SINCE,
  FILE_MODIFIED_SINCE,
  FILE_MOVE_CONFLICT,
  FILE_WRITE_LOCKED,
  FILE_PERMISSION_DENIED,
  FILE_TOO_LARGE,
  FILE_INVALID_PATH,
  FILE_EXCEEDS_STORAGE_QUOTA,
  FILE_NOT_DIRECTORY,
  FILE_OTHER_ERROR,
}

export class FileOperationError extends Error {
  constructor(message: string, readonly fileOperationResult: FileOperationResult, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FileOperationError';
  }
}

export interface IStat {
  readonly type: FileType;
  readonly ctime: number;
  readonly mtime: number;
  readonly size: number;
}

export function etag({ mtime, size }: Pick<IStat, 'mtime' | 'size'>): string {
  return mtime.toString(29) + size.toString(31);
}

export interface IFileStat extends IStat {
  readonly resource: URI;
  readonly name: string;
  readonly etag: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly readonly: boolean;
  readonly children?: readonly IFileStat[];
}

export interface IFileContent extends IFileStat {
  readonly value: Uint8Array;
}

export interface IFileReadOptions {
  readonly limits?: { readonly size?: number };
  readonly signal?: AbortSignal;
}

export interface IFileWriteOptions {
  readonly create: boolean;
  readonly overwrite: boolean;
  readonly etag?: string;
  readonly createParents?: boolean;
}

export interface IWriteFileOptions {
  readonly etag?: string;
}

export interface IMkdirOptions {
  readonly recursive?: boolean;
}

export interface IFileDeleteOptions {
  readonly recursive: boolean;
}

export interface IFileOverwriteOptions {
  readonly overwrite: boolean;
}

export interface IWatchOptions {
  readonly recursive: boolean;
  readonly excludes?: readonly string[];
}

export enum FileChangeType { UPDATED, ADDED, DELETED }

export interface IFileChange {
  readonly resource: URI;
  readonly type: FileChangeType;
}

export class FileChangesEvent {
  constructor(readonly changes: readonly IFileChange[]) {}

  contains(resource: URI, ...types: FileChangeType[]): boolean {
    return this.changes.some(change => (!types.length || types.includes(change.type))
      && (change.type === FileChangeType.DELETED
        ? isEqualOrParent(resource, change.resource)
        : isEqual(resource, change.resource)));
  }

  affects(resource: URI, ...types: FileChangeType[]): boolean {
    return this.contains(resource, ...types) || this.changes.some(change =>
      (!types.length || types.includes(change.type)) && isEqualOrParent(change.resource, resource));
  }
}

export enum FileOperation { CREATE, DELETE, MOVE, COPY }

export class FileOperationEvent {
  constructor(readonly resource: URI, readonly operation: FileOperation, readonly target?: IFileStat) {}

  isOperation(operation: FileOperation): boolean {
    return this.operation === operation;
  }
}

export interface IFileOperationParticipantEvent {
  readonly operation: FileOperation;
  readonly resource: URI;
  readonly target?: URI;
  waitUntil(promise: PromiseLike<unknown>): void;
}

export interface IFileSystemProviderActivationEvent {
  readonly scheme: string;
  join(promise: PromiseLike<unknown>): void;
}

export interface IFileSystemProviderRegistrationEvent {
  readonly scheme: string;
  readonly added: boolean;
  readonly provider?: IFileSystemProvider;
}

export interface IFileSystemProvider {
  readonly capabilities: FileSystemProviderCapabilities;
  readonly onDidChangeCapabilities?: Event<void>;
  readonly onDidChangeFile: Event<readonly IFileChange[]>;
  /** True when what this provider stores now goes away with the page. Absent means the provider does not say. */
  readonly usesMemory?: boolean;
  stat(resource: URI): Promise<IStat>;
  readdir(resource: URI): Promise<readonly [string, FileType][]>;
  readFile(resource: URI, options?: IFileReadOptions): Promise<Uint8Array>;
  /** Providers with a transactional snapshot return content and its matching stat together. */
  readFileWithStat?(resource: URI, options?: IFileReadOptions): Promise<{ stat: IStat; value: Uint8Array }>;
  writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions): Promise<void | IStat>;
  mkdir(resource: URI, options?: IMkdirOptions): Promise<void>;
  rename(from: URI, to: URI, options: IFileOverwriteOptions): Promise<void>;
  copy?(from: URI, to: URI, options: IFileOverwriteOptions): Promise<void>;
  delete(resource: URI, options: IFileDeleteOptions): Promise<void>;
  watch(resource: URI, options: IWatchOptions): IDisposable;
}

export const IFileService = createDecorator<IFileService>('fileService');

export interface IFileService {
  readonly _serviceBrand: undefined;
  readonly onDidChangeFileSystemProviderRegistrations: Event<IFileSystemProviderRegistrationEvent>;
  readonly onWillActivateFileSystemProvider: Event<IFileSystemProviderActivationEvent>;
  readonly onDidFilesChange: Event<FileChangesEvent>;
  readonly onWillRunOperation: Event<IFileOperationParticipantEvent>;
  readonly onDidRunOperation: Event<FileOperationEvent>;
  readonly onDidWatchError: Event<unknown>;
  registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable;
  getProvider(scheme: string): IFileSystemProvider | undefined;
  hasProvider(resource: URI): boolean;
  activateProvider(scheme: string): Promise<void>;
  stat(resource: URI): Promise<IFileStat>;
  resolve(resource: URI): Promise<IFileStat>;
  exists(resource: URI): Promise<boolean>;
  readFile(resource: URI, options?: IFileReadOptions): Promise<IFileContent>;
  writeFile(resource: URI, content: Uint8Array, options?: IWriteFileOptions): Promise<IFileStat>;
  createFile(resource: URI, content?: Uint8Array, options?: Partial<IFileOverwriteOptions>): Promise<IFileStat>;
  createFolder(resource: URI): Promise<IFileStat>;
  move(source: URI, target: URI, overwrite?: boolean): Promise<IFileStat>;
  copy(source: URI, target: URI, overwrite?: boolean): Promise<IFileStat>;
  del(resource: URI, options?: Partial<IFileDeleteOptions>): Promise<void>;
  watch(resource: URI, options?: Partial<IWatchOptions>): IDisposable;
}
