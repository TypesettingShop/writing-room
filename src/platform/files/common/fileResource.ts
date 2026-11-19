import { Schemas } from '../../../base/common/network.js';
import { normalize } from '../../../base/common/path.js';
import type { URI } from '../../../base/common/uri.js';
import { FileSystemProviderError, FileSystemProviderErrorCode } from './files.js';

export const workspaceAuthority = 'writing-room';
const settingsPath = '/User/settings.json';
const forbiddenFilePath = /[\\\x00-\x1F\x7F-\x9F]|%(?:25)*(?:2f|5c)/i;

export function fileAuthority(scheme: string): string {
  return scheme === Schemas.vscodeVfs ? workspaceAuthority : '';
}

export function isFileStoragePath(scheme: string, path: string): boolean {
  return path.startsWith('/') && !forbiddenFilePath.test(path) && normalize(path) === path
    && !(scheme === Schemas.vscodeUserData && (path === settingsPath || path.startsWith(settingsPath + '/')));
}

/** Validate before turning a persistent resource into a storage key or checking its scope. */
export function normalizeFileResource(resource: URI): URI {
  const path = normalize(resource.path);
  if (resource.authority !== fileAuthority(resource.scheme) || !resource.path.startsWith('/')
    || resource.query || resource.fragment || resource.hasEncodedPathSeparator || forbiddenFilePath.test(resource.path)
    || !isFileStoragePath(resource.scheme, path)) {
    throw new FileSystemProviderError('Invalid file resource', FileSystemProviderErrorCode.NoPermissions);
  }
  return resource.with({ path });
}
