import { Schemas } from '../../../base/common/network.js';
import { normalize } from '../../../base/common/path.js';
import { isEqualOrParent } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { normalizeFileResource } from '../../../platform/files/common/fileResource.js';
import { FileSystemProviderError, FileSystemProviderErrorCode } from '../../../platform/files/common/files.js';
import type { IWorkspace } from '../../../platform/workspace/common/workspace.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { extensionGlobalStorageUri, extensionWorkspaceStorageUri } from '../../services/extensions/common/extensionStoragePaths.js';

const unsafePath = /[\\\x00-\x1f\x7f-\x9f]|%(?:25)*(?:2f|5c|0[\da-f]|1[\da-f]|7f|8[\da-f]|9[\da-f])/i;
const escapedDotSegment = /(?:^|\/)(?:\.|%(?:25)*2e){1,2}(?:\/|$)/i;

function deny(): never {
  throw new FileSystemProviderError('Access to this file resource is denied.', FileSystemProviderErrorCode.NoPermissions);
}

export function normalizeExtensionFileResource(resource: URI): URI {
  if (!URI.isUri(resource) || resource.hasEncodedPathSeparator || unsafePath.test(resource.path)
    || !resource.path.startsWith('/')) {
    return deny();
  }
  const path = normalize(resource.path);
  // URI.parse decodes escaped dot segments. Reject any that still have an escaped spelling.
  if (escapedDotSegment.test(path)) {
    return deny();
  }
  if (resource.scheme === Schemas.vscodeVfs || resource.scheme === Schemas.vscodeUserData) {
    return normalizeFileResource(resource);
  }
  return resource.with({ path });
}

const packageRoot = URI.parse('vscode-userdata:/extensions');

function packagePath(resource: URI): boolean {
  return resource.scheme === Schemas.http || resource.scheme === Schemas.https
    || isEqualOrParent(resource, packageRoot);
}

/** All extension file requests and event visibility use the same normalized resource. */
export class ExtensionFileAccess {
  constructor(
    private readonly workspace: IWorkspace,
    private readonly packageLocations: () => readonly string[],
    private readonly isExtensionFileSystem: (scheme: string) => boolean,
  ) {}

  isAllowed(extension: HostExtensionDescription, normalized: URI, write: boolean): boolean {
    if (this.workspace.folders.some(folder => isEqualOrParent(normalized, folder.uri))
      || this.isExtensionFileSystem(normalized.scheme)
      || isEqualOrParent(normalized, extensionGlobalStorageUri(extension.id))
      || isEqualOrParent(normalized, extensionWorkspaceStorageUri(this.workspace.id, extension.id))) {
      return true;
    }
    if (write || !packagePath(normalized)) {
      return false;
    }
    return this.packageLocations().some(location => {
      try {
        const base = normalizeExtensionFileResource(URI.parse(location, true));
        return packagePath(base) && isEqualOrParent(normalized, base);
      } catch {
        return false;
      }
    });
  }

  require(extension: HostExtensionDescription, resource: URI, write: boolean): URI {
    const normalized = normalizeExtensionFileResource(resource);
    return this.isAllowed(extension, normalized, write) ? normalized : deny();
  }
}
