import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import {
  createFileSystemProviderError, FileChangeType, FileOperationError, FileOperationResult,
  FileSystemProviderCapabilities as Cap, FileSystemProviderErrorCode as Code, FileType,
  type FileSystemProviderError, type IFileChange, type IFileReadOptions, type IFileSystemProvider, type IFileWriteOptions, type IStat,
} from '../../../../platform/files/common/files.js';
import { isManuscriptId, ManuscriptStoreError, type DocumentStat } from '../../../../platform/manuscript/common/manuscript.js';
import type { IManuscriptService } from '../common/manuscriptService.js';
import { ManuscriptUnavailableError } from './httpManuscriptStore.js';

export const manuscriptScheme = 'manuscript';

export function manuscriptDocumentUri(workId: string, nodeId: string): URI {
  return URI.from({ scheme: manuscriptScheme, authority: workId, path: '/' + nodeId + '.md' });
}

function fileStat({ mtime, size }: DocumentStat): IStat {
  return { type: FileType.File, ctime: 0, mtime, size };
}

function providerError(error: unknown): unknown {
  if (error instanceof ManuscriptStoreError) {
    switch (error.code) {
      case 'precondition_failed':
        return new FileOperationError(error.message, FileOperationResult.FILE_MODIFIED_SINCE, { cause: error });
      case 'not_found':
        return createFileSystemProviderError(error, Code.FileNotFound);
      case 'unauthorized':
        return createFileSystemProviderError(error, Code.NoPermissions);
      case 'too_large':
        return createFileSystemProviderError(error, Code.FileTooLarge);
    }
  }
  return error instanceof ManuscriptUnavailableError ? createFileSystemProviderError(error, Code.Unavailable) : error;
}

function disallowStructure(): FileSystemProviderError {
  return createFileSystemProviderError('Change the manuscript tree through the manuscript store.', Code.NoPermissions);
}

export class ManuscriptFileSystemProvider extends Disposable implements IFileSystemProvider {
  readonly capabilities = Cap.FileReadWrite | Cap.FileAtomicWrite | Cap.PathCaseSensitive;
  private readonly changed = this._register(new Emitter<readonly IFileChange[]>());
  readonly onDidChangeFile = this.changed.event;
  readonly usesMemory: boolean;
  private readonly service: IManuscriptService;
  private readonly currentWorkId: () => string | undefined;

  constructor(service: IManuscriptService, currentWorkId: () => string | undefined) {
    super();
    this.service = service;
    this.usesMemory = service.usesMemory;
    this.currentWorkId = currentWorkId;
    this._register(service.onDidDeleteDocuments(({ workId, nodeIds }) => {
      if (workId === this.currentWorkId()) {
        this.changed.fire(nodeIds.map(nodeId => ({
          type: FileChangeType.DELETED, resource: manuscriptDocumentUri(workId, nodeId),
        })));
      }
    }));
  }

  async stat(resource: URI): Promise<IStat> {
    this.validateWork(resource);
    if (resource.path === '/') {
      return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const nodeId = this.documentId(resource);
    try {
      return fileStat(await this.service.store.statDocument(resource.authority, nodeId));
    } catch (error) {
      throw providerError(error);
    }
  }

  async readdir(resource: URI): Promise<readonly [string, FileType][]> {
    this.validateWork(resource);
    if (resource.path !== '/') {
      await this.stat(resource);
      throw createFileSystemProviderError(resource.path, Code.FileNotADirectory);
    }
    return [];
  }

  async readFile(resource: URI, options?: IFileReadOptions): Promise<Uint8Array> {
    return (await this.readFileWithStat(resource, options)).value;
  }

  async readFileWithStat(resource: URI, options?: IFileReadOptions): Promise<{ stat: IStat; value: Uint8Array }> {
    const nodeId = this.documentId(resource);
    options?.signal?.throwIfAborted();
    try {
      const document = await this.service.store.readDocument(resource.authority, nodeId);
      options?.signal?.throwIfAborted();
      if (options?.limits?.size !== undefined && document.size > options.limits.size) {
        throw createFileSystemProviderError(resource.path, Code.FileTooLarge);
      }
      return { stat: fileStat(document), value: new TextEncoder().encode(document.content) };
    } catch (error) {
      throw providerError(error);
    }
  }

  async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions): Promise<IStat> {
    const nodeId = this.documentId(resource);
    if (!options.overwrite) {
      await this.stat(resource);
      throw createFileSystemProviderError(resource.path, Code.FileExists);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      throw createFileSystemProviderError('Manuscript documents require UTF-8.', Code.Unknown);
    }
    try {
      const stat = await this.service.store.writeDocument(resource.authority, nodeId, text, options.etag);
      this.changed.fire([{ resource, type: FileChangeType.UPDATED }]);
      return fileStat(stat);
    } catch (error) {
      throw providerError(error);
    }
  }

  async mkdir(): Promise<void> { throw disallowStructure(); }
  async delete(): Promise<void> { throw disallowStructure(); }
  async rename(): Promise<void> { throw disallowStructure(); }
  watch() { return Disposable.None; }

  private validateWork(resource: URI): void {
    if (resource.scheme !== manuscriptScheme || !isManuscriptId(resource.authority) || resource.authority !== this.currentWorkId() ||
      resource.query || resource.rawQuery !== undefined || resource.fragment || resource.hasEncodedPathSeparator) {
      throw createFileSystemProviderError(resource.path, Code.NoPermissions);
    }
  }

  private documentId(resource: URI): string {
    this.validateWork(resource);
    if (resource.path === '/') {
      throw createFileSystemProviderError(resource.path, Code.FileIsADirectory);
    }
    const id = resource.path.slice(1, -3);
    if (!isManuscriptId(id) || resource.path !== '/' + id + '.md') {
      throw createFileSystemProviderError(resource.path, Code.FileNotFound);
    }
    return id;
  }
}
