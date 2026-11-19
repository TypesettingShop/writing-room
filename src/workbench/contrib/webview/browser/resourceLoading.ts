import { Schemas } from '../../../../base/common/network.js';
import { extname, isEqualOrParent, normalizePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import { extensionResourceLimits } from '../../../services/extensions/common/extensionResources.js';
import { webviewResourcePrefix } from '../common/webviewUri.js';

const unsafe = /[\\\x00-\x1f\x7f]|%(?:25)*(?:2e|2f|5c)/i;
const mimeTypes: Readonly<Record<string, string>> = {
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.css': 'text/css', '.gif': 'image/gif',
  '.htm': 'text/html', '.html': 'text/html', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json', '.mjs': 'text/javascript',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.ogg': 'audio/ogg', '.otf': 'font/otf',
  '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf',
  '.txt': 'text/plain', '.wasm': 'application/wasm', '.webm': 'video/webm', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

export function normalizeWebviewResource(resource: URI): URI | undefined {
  const installedPackage = resource.scheme === Schemas.vscodeUserData && !resource.authority
    && /^\/extensions\/[^/.][^/]*(?:\/|$)/.test(resource.path);
  if (resource.hasEncodedPathSeparator || !resource.path.startsWith('/') || unsafe.test(resource.path)
    || /[@%/?#\\\s]/.test(resource.authority) || resource.path.split('/').includes('..')
    || (resource.scheme !== Schemas.vscodeVfs && resource.scheme !== Schemas.http && resource.scheme !== Schemas.https && !installedPackage)) {
    return undefined;
  }
  const normalized = normalizePath(resource.with({ query: '', fragment: '' }));
  return normalized.path.length > 1 ? normalized.with({ path: normalized.path.replace(/\/+$/, '') }) : normalized;
}

function decodeResource(path: string): URI | undefined {
  if (!path.startsWith(webviewResourcePrefix)) {
    return undefined;
  }
  const [scheme, authority, ...segments] = path.slice(webviewResourcePrefix.length).split('/');
  try {
    const parts = segments.map(decodeURIComponent);
    if (!parts.length || parts.some(segment => segment.includes('/') || unsafe.test(segment))) {
      return undefined;
    }
    return normalizeWebviewResource(URI.from({
      scheme: decodeURIComponent(scheme), authority: decodeURIComponent(authority), path: '/' + parts.join('/'),
    }, true));
  } catch {
    return undefined;
  }
}

export type WebviewResource =
  | { readonly status: 200; readonly mime: string; readonly bytes: Uint8Array }
  | { readonly status: 401 | 404 | 413 };

export async function loadWebviewResource(
  fileService: IFileService, path: string, roots: readonly URI[], signal: AbortSignal,
): Promise<WebviewResource> {
  const resource = decodeResource(path);
  if (!resource || !roots.some(root => {
    const normalized = normalizeWebviewResource(root);
    return normalized && isEqualOrParent(resource, normalized);
  })) {
    return { status: 401 };
  }
  try {
    const { value } = await fileService.readFile(resource, { limits: { size: extensionResourceLimits.webview }, signal });
    return { status: 200, mime: mimeTypes[extname(resource).toLowerCase()] ?? 'application/octet-stream', bytes: value };
  } catch (error) {
    const code = toFileSystemProviderErrorCode(error);
    return { status: code === FileSystemProviderErrorCode.NoPermissions ? 401
      : code === FileSystemProviderErrorCode.FileTooLarge ? 413 : 404 };
  }
}
