import type * as vscode from 'vscode';
import { parse } from '../../../base/common/glob.js';
import { normalize } from '../../../base/common/path.js';
import { isEqualOrParent } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { isExtensionFileSystemScheme } from './extHostFileSystemSchemes.js';
import type { FileGlobDto, WorkspaceFolderDto } from './extHost.protocol.fileSystem.js';

export function toFileGlob(pattern: vscode.GlobPattern, folders: readonly WorkspaceFolderDto[]): FileGlobDto {
  if (typeof pattern === 'string') {
    return pattern;
  }
  if (URI.isUri(pattern?.baseUri) && typeof pattern.pattern === 'string') {
    let base = pattern.baseUri;
    // RelativePattern constructed with a path string uses file:. Resolve that spelling against the
    // virtual workspace just as workspace.asRelativePath resolves an absolute path string.
    const folder = folders.find(folder => base.scheme === 'file' && !base.authority && !base.hasEncodedPathSeparator
      && isEqualOrParent(folder.uri.with({ path: normalize(base.path) }), folder.uri));
    if (folder) {
      base = URI.from({ ...folder.uri.toJSON(), path: base.path });
    } else if (isExtensionFileSystemScheme(base.scheme.toLowerCase())) {
      base = base.with({ scheme: base.scheme.toLowerCase() });
    }
    return { base, pattern: pattern.pattern };
  }
  throw new TypeError('Expected a glob string or RelativePattern.');
}

export function compileFileGlob(glob: FileGlobDto, root: URI): (resource: URI) => boolean {
  const base = typeof glob === 'string' ? root : glob.base;
  const pattern = typeof glob === 'string' ? glob : glob.pattern;
  const matcher = parse({ base: base.path, pattern });
  return candidate => isEqualOrParent(candidate, base) && matcher(candidate.path);
}
