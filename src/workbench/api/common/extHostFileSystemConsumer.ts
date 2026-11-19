import type * as vscode from 'vscode';
import { TransferableBuffer } from '../../../base/common/marshalling.js';
import { URI } from '../../../base/common/uri.js';
import {
  FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, toFileSystemProviderErrorCode,
} from '../../../platform/files/common/files.js';
import type { MainThreadFileSystemShape } from './extHost.protocol.fileSystem.js';
import { guardApiMethod, promiseApiMethod } from './extHostApiRegistry.js';

export { FileType };

export enum FilePermission {
  Readonly = 1,
}

const Code = FileSystemProviderErrorCode;
const apiCodes = new Map<FileSystemProviderErrorCode, string>([
  [Code.FileNotFound, 'FileNotFound'],
  [Code.FileExists, 'FileExists'],
  [Code.FileNotADirectory, 'FileNotADirectory'],
  [Code.FileIsADirectory, 'FileIsADirectory'],
  [Code.NoPermissions, 'NoPermissions'],
  [Code.Unavailable, 'Unavailable'],
]);

export class FileSystemError extends Error implements vscode.FileSystemError {
  readonly code: string;

  constructor(messageOrUri?: string | URI, providerCode = Code.Unknown) {
    super(URI.isUri(messageOrUri) ? messageOrUri.toString(true) : messageOrUri);
    this.name = `${providerCode} (FileSystemError)`;
    this.code = apiCodes.get(providerCode) ?? 'Unknown';
  }

  static FileNotFound(messageOrUri?: string | URI): FileSystemError {
    return new FileSystemError(messageOrUri, Code.FileNotFound);
  }

  static FileExists(messageOrUri?: string | URI): FileSystemError {
    return new FileSystemError(messageOrUri, Code.FileExists);
  }

  static FileNotADirectory(messageOrUri?: string | URI): FileSystemError {
    return new FileSystemError(messageOrUri, Code.FileNotADirectory);
  }

  static FileIsADirectory(messageOrUri?: string | URI): FileSystemError {
    return new FileSystemError(messageOrUri, Code.FileIsADirectory);
  }

  static NoPermissions(messageOrUri?: string | URI): FileSystemError {
    return new FileSystemError(messageOrUri, Code.NoPermissions);
  }

  static Unavailable(messageOrUri?: string | URI): FileSystemError {
    return new FileSystemError(messageOrUri, Code.Unavailable);
  }
}

function fileUri(value: vscode.Uri): URI {
  if (!URI.isUri(value)) {
    throw FileSystemError.NoPermissions('Expected a file URI.');
  }
  return value;
}

export class ExtHostFileSystemConsumer {
  readonly capabilities = new Map<string, FileSystemProviderCapabilities>();

  constructor(private readonly proxy: MainThreadFileSystemShape, private readonly isLive: (key: string) => boolean) {}

  createApi(key: string): vscode.FileSystem {
    const checkLive = () => {
      if (!this.isLive(key)) {
        throw new Error(`Extension '${key}' is no longer active.`);
      }
    };
    const call = <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>) =>
      guardApiMethod(promiseApiMethod(async (...args: Args) => {
        try {
          return await method(...args);
        } catch (error) {
          throw new FileSystemError(error instanceof Error ? error.message : String(error), toFileSystemProviderErrorCode(error));
        }
      }), checkLive);

    return Object.freeze<vscode.FileSystem>({
      stat: call(uri => this.proxy.$stat(key, fileUri(uri))),
      readDirectory: call(async uri => [...await this.proxy.$readDirectory(key, fileUri(uri))]),
      createDirectory: call(uri => this.proxy.$createDirectory(key, fileUri(uri))),
      readFile: call(async uri => {
        const data = await this.proxy.$readFile(key, fileUri(uri));
        if (!(data instanceof Uint8Array)) {
          throw new TypeError('Expected file contents as Uint8Array.');
        }
        return data;
      }),
      // The caller keeps ownership of its original data and can still use sibling views.
      writeFile: call((uri, content) => {
        if (!(content instanceof Uint8Array)) {
          throw new TypeError('Expected file contents as Uint8Array.');
        }
        return this.proxy.$writeFile(key, fileUri(uri), new TransferableBuffer(new Uint8Array(content)));
      }),
      delete: call((uri, options) => this.proxy.$delete(key, fileUri(uri), options)),
      rename: call((source, target, options) => this.proxy.$rename(key, fileUri(source), fileUri(target), options)),
      copy: call((source, target, options) => this.proxy.$copy(key, fileUri(source), fileUri(target), options)),
      isWritableFileSystem: guardApiMethod((scheme: string) => {
        const capabilities = this.capabilities.get(scheme);
        return capabilities === undefined ? undefined : !(capabilities & FileSystemProviderCapabilities.Readonly);
      }, checkLive),
    });
  }
}
