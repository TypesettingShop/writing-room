import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import type { URI } from '../../../../base/common/uri.js';
import {
  fetchBoundedResource, ResourceResponseError, ResourceTooLargeError,
} from '../../../../base/parts/request/common/boundedFetch.js';
import {
  FileSystemProviderCapabilities, FileSystemProviderError, FileSystemProviderErrorCode, FileType,
} from '../../../../platform/files/common/files.js';
import type { IFileReadOptions, IFileSystemProvider, IStat } from '../../../../platform/files/common/files.js';

const Code = FileSystemProviderErrorCode;

export class FetchFileSystemProvider implements IFileSystemProvider {
  readonly capabilities = FileSystemProviderCapabilities.Readonly | FileSystemProviderCapabilities.PathCaseSensitive;
  readonly onDidChangeFile = Event.None;

  constructor(private readonly request?: typeof fetch) {}

  async stat(resource: URI): Promise<IStat> {
    const { headers } = await this.fetch(resource, 0, undefined, 'HEAD');
    const size = Number(headers.get('Content-Length'));
    return toStat(headers, Number.isSafeInteger(size) && size >= 0 ? size : 0);
  }

  async readFile(resource: URI, options?: IFileReadOptions): Promise<Uint8Array> {
    return (await this.readFileWithStat(resource, options)).value;
  }

  async readFileWithStat(resource: URI, options?: IFileReadOptions): Promise<{ stat: IStat; value: Uint8Array }> {
    const limit = options?.limits?.size;
    if (limit === undefined || !Number.isSafeInteger(limit) || limit < 0) {
      throw new FileSystemProviderError('A byte limit is required for remote file reads', Code.NoPermissions);
    }
    const { bytes, headers } = await this.fetch(resource, limit, options?.signal);
    return { stat: toStat(headers, bytes.byteLength), value: bytes };
  }

  async readdir(): Promise<never> {
    throw new FileSystemProviderError('Remote directory listing is unavailable', Code.Unavailable);
  }

  async writeFile(): Promise<never> { return this.denyWrite(); }
  async mkdir(): Promise<never> { return this.denyWrite(); }
  async rename(): Promise<never> { return this.denyWrite(); }
  async delete(): Promise<never> { return this.denyWrite(); }

  watch(): typeof Disposable.None {
    return Disposable.None;
  }

  private denyWrite(): never {
    throw new FileSystemProviderError('Remote file system is read-only', Code.NoPermissions);
  }

  private async fetch(resource: URI, limit: number, signal?: AbortSignal, method?: 'HEAD') {
    const url = toURL(resource);
    try {
      return await fetchBoundedResource(url, { limit, signal, request: this.request, method });
    } catch (error) {
      signal?.throwIfAborted();
      let code = Code.Unavailable;
      if (error instanceof ResourceTooLargeError) {
        code = Code.FileTooLarge;
      } else if (error instanceof ResourceResponseError) {
        if (error.status === 404 || error.status === 410) {
          code = Code.FileNotFound;
        } else if (error.status === 401 || error.status === 403) {
          code = Code.NoPermissions;
        }
      }
      throw new FileSystemProviderError(`Could not read remote resource: ${resource.path}`, code, { cause: error });
    }
  }
}

function toStat(headers: Headers, size: number): IStat {
  const mtime = Date.parse(headers.get('Last-Modified') ?? '') || 0;
  return { type: FileType.File, ctime: 0, mtime, size };
}

function toURL(resource: URI): URL {
  if ((resource.scheme !== Schemas.http && resource.scheme !== Schemas.https) || !resource.authority
    || /[@%/?#\\\s\x00-\x1f\x7f]/.test(resource.authority)
    || resource.hasEncodedPathSeparator || /[\\\x00-\x1f\x7f]/.test(resource.path)) {
    throw new FileSystemProviderError('Invalid remote resource URL', Code.NoPermissions);
  }
  try {
    const url = new URL(`${resource.scheme}://${resource.authority}`);
    url.pathname = resource.path.split('/').map(encodeURIComponent).join('/');
    url.search = resource.query ? '?' + resource.encodedHttpQuery : '';
    return url;
  } catch (error) {
    throw new FileSystemProviderError('Invalid remote resource URL', Code.NoPermissions, { cause: error });
  }
}
