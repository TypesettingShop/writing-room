import { Schemas } from '../../../base/common/network.js';
import { normalize } from '../../../base/common/path.js';
import type { URI } from '../../../base/common/uri.js';
import { FileSystemProviderError, FileSystemProviderErrorCode } from './files.js';

export const workspaceAuthority = 'writing-room';

/** Validate before turning a persistent resource into a storage key or checking its scope. */
export function normalizeFileResource(resource: URI): URI {
  const expectedAuthority = resource.scheme === Schemas.vscodeVfs ? workspaceAuthority : '';
  if (resource.authority !== expectedAuthority || !resource.path.startsWith('/')
    || resource.query || resource.fragment || resource.hasEncodedPathSeparator
    || /[\\\x00-\x1F\x7F-\x9F]|%(?:25)*(?:2f|5c)/i.test(resource.path)) {
    throw new FileSystemProviderError('Invalid file resource', FileSystemProviderErrorCode.NoPermissions);
  }
  return resource.with({ path: normalize(resource.path) });
}
