import { raceCancellation } from '../../../base/common/async.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { TransferableBuffer } from '../../../base/common/marshalling.js';
import type { URI } from '../../../base/common/uri.js';
import { FileSystemProviderCapabilities, FileSystemProviderError, FileSystemProviderErrorCode } from '../../../platform/files/common/files.js';
import type {
  IFileChange, IFileDeleteOptions, IFileOverwriteOptions, IFileReadOptions, IFileSystemProvider, IFileWriteOptions, IWatchOptions,
} from '../../../platform/files/common/files.js';
import { fileProviderDirectory, fileProviderStat } from '../common/extHostFileSystemProviderData.js';
import type { ExtHostFileSystemProviderShape } from '../common/extHost.protocol.fileSystem.js';

export class MainThreadFileSystemProvider extends Disposable implements IFileSystemProvider {
  private readonly receivedChanges = this._register(new Emitter<readonly IFileChange[]>());
  readonly onDidChangeFile = this.receivedChanges.event;
  private readonly lifetime = new CancellationTokenSource();
  private readonly watches = this._register(new DisposableStore());
  private nextWatch = 0;

  readonly copy?: IFileSystemProvider['copy'];

  constructor(
    readonly extension: string,
    readonly handle: number,
    readonly capabilities: FileSystemProviderCapabilities,
    private readonly proxy: ExtHostFileSystemProviderShape,
  ) {
    super();
    if (capabilities & FileSystemProviderCapabilities.FileFolderCopy) {
      this.copy = (from, to, options) => this.run(token => proxy.$providerCopy(extension, handle, from, to, options, token));
    }
  }

  acceptChanges(changes: readonly IFileChange[]): void {
    this.receivedChanges.fire(changes);
  }

  async stat(resource: URI) {
    return fileProviderStat(await this.run(token => this.proxy.$providerStat(this.extension, this.handle, resource, token)));
  }

  async readdir(resource: URI) {
    return fileProviderDirectory(await this.run(token => this.proxy.$providerReadDirectory(this.extension, this.handle, resource, token)));
  }

  mkdir(resource: URI) {
    return this.run(token => this.proxy.$providerCreateDirectory(this.extension, this.handle, resource, token));
  }

  async readFile(resource: URI, options?: IFileReadOptions): Promise<Uint8Array> {
    const bytes = await this.run(token =>
      this.proxy.$providerReadFile(this.extension, this.handle, resource, options?.limits?.size, token), options?.signal);
    if (!(bytes instanceof Uint8Array)) {
      throw new FileSystemProviderError('Invalid file contents from the extension provider.', FileSystemProviderErrorCode.Unknown);
    }
    return bytes;
  }

  writeFile(resource: URI, content: Uint8Array, { create, overwrite }: IFileWriteOptions) {
    const bytes = new TransferableBuffer(new Uint8Array(content));
    return this.run(token => this.proxy.$providerWriteFile(this.extension, this.handle, resource, bytes, { create, overwrite }, token));
  }

  delete(resource: URI, options: IFileDeleteOptions) {
    return this.run(token => this.proxy.$providerDelete(this.extension, this.handle, resource, options, token));
  }

  rename(from: URI, to: URI, options: IFileOverwriteOptions) {
    return this.run(token => this.proxy.$providerRename(this.extension, this.handle, from, to, options, token));
  }

  watch(resource: URI, options: IWatchOptions): IDisposable {
    if (this.lifetime.token.isCancellationRequested) {
      return Disposable.None;
    }
    const watch = this.nextWatch++;
    const registration = this.watches.add(toDisposable(() => {
      void this.proxy.$providerUnwatch(this.extension, this.handle, watch).catch(() => {});
    }));
    void this.proxy.$providerWatch(this.extension, this.handle, watch, resource, options).catch(() => this.watches.delete(registration));
    return toDisposable(() => this.watches.delete(registration));
  }

  private unavailable(): FileSystemProviderError {
    return new FileSystemProviderError('The extension file system provider is no longer running.', FileSystemProviderErrorCode.Unavailable);
  }

  private async run<T>(request: (token: CancellationToken) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.lifetime.token.isCancellationRequested) {
      throw this.unavailable();
    }
    signal?.throwIfAborted();
    const source = new CancellationTokenSource(this.lifetime.token);
    const abort = () => source.cancel();
    signal?.addEventListener('abort', abort);
    try {
      const result = await raceCancellation(request(source.token), source.token);
      signal?.throwIfAborted();
      if (this.lifetime.token.isCancellationRequested) {
        throw this.unavailable();
      }
      return result as T;
    } catch (error) {
      throw this.lifetime.token.isCancellationRequested ? this.unavailable() : error;
    } finally {
      signal?.removeEventListener('abort', abort);
      source.dispose();
    }
  }

  override dispose(): void {
    this.lifetime.dispose(true);
    super.dispose();
  }
}
