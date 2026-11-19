import { CancellationToken } from '../../../base/common/cancellation.js';
import { raceCancellation } from '../../../base/common/async.js';
import { isEqualOrParent } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { FileSystemProviderErrorCode, FileType, toFileSystemProviderErrorCode } from '../../../platform/files/common/files.js';
import type { IFileService } from '../../../platform/files/common/files.js';
import type { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import type { FileGlobDto, WorkspaceFolderDto } from '../common/extHost.protocol.fileSystem.js';
import { compileFileGlob } from '../common/extHostFileSystemGlob.js';
import { normalizeExtensionFileResource } from './extensionFileAccess.js';

const resultLimit = 20_000;
const visitLimit = 100_000;
const defaultExclude = '{**/.git/**,**/node_modules/**}';

function checkedGlob(glob: FileGlobDto): FileGlobDto {
  if (typeof glob === 'string') {
    return glob;
  }
  if (!glob || typeof glob.pattern !== 'string') {
    throw new TypeError('Expected a glob string or relative glob.');
  }
  return { base: normalizeExtensionFileResource(glob.base), pattern: glob.pattern };
}

export class MainThreadWorkspace {
  constructor(private readonly context: IWorkspaceContextService, private readonly files: IFileService) {}

  get folders(): readonly WorkspaceFolderDto[] {
    return this.context.getWorkspace().folders.map(({ uri, name, index }) => ({ uri, name, index }));
  }

  async findFiles(
    include: FileGlobDto, exclude: FileGlobDto | null | undefined = undefined, maxResults = resultLimit,
    token: CancellationToken = CancellationToken.None,
  ): Promise<URI[]> {
    if (!Number.isSafeInteger(maxResults) || maxResults < 0) {
      throw new RangeError('File search result limit must be a non-negative integer.');
    }
    const limit = Math.min(maxResults, resultLimit);
    const inclusion = checkedGlob(include);
    const exclusion = exclude === null ? undefined : checkedGlob(exclude ?? defaultExclude);
    const result: URI[] = [];
    let visited = 0;
    for (const { uri: root } of this.context.getWorkspace().folders) {
      if (token.isCancellationRequested || result.length === limit || visited >= visitLimit) {
        break;
      }
      const provider = this.files.getProvider(root.scheme);
      if (!provider) {
        continue;
      }
      let searchRoot = root;
      if (typeof inclusion !== 'string') {
        if (isEqualOrParent(inclusion.base, root)) {
          searchRoot = inclusion.base;
        } else if (!isEqualOrParent(root, inclusion.base)) {
          continue;
        }
      }
      const matches = compileFileGlob(inclusion, root);
      const excluded = exclusion === undefined ? undefined : compileFileGlob(exclusion, root);
      const queue = [searchRoot];
      for (let index = 0; index < queue.length; index++) {
        if (token.isCancellationRequested || result.length === limit || visited >= visitLimit) {
          break;
        }
        const directory = queue[index];
        if (excluded?.(directory)) {
          continue;
        }
        try {
          const entries = await raceCancellation(provider.readdir(directory), token);
          for (const [name, type] of entries ?? []) {
            if (token.isCancellationRequested || result.length === limit || visited >= visitLimit) {
              break;
            }
            if (++visited % 128 === 0) {
              await new Promise<void>(resolve => setTimeout(resolve, 0));
              if (token.isCancellationRequested) {
                break;
              }
            }
            if (!name || name === '.' || name === '..' || /[/\\]/.test(name) || type & FileType.SymbolicLink) {
              continue;
            }
            const uri = URI.joinPath(directory, name);
            if (excluded?.(uri)) {
              continue;
            }
            if (type & FileType.Directory) {
              queue.push(uri);
            } else if (type & FileType.File && matches(uri)) {
              result.push(uri);
            }
          }
        } catch (error) {
          const code = toFileSystemProviderErrorCode(error);
          // A directory may be moved or deleted while a search is in flight.
          if (code !== FileSystemProviderErrorCode.FileNotFound && code !== FileSystemProviderErrorCode.FileNotADirectory) {
            throw error;
          }
        }
      }
    }
    return result;
  }
}
