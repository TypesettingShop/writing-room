import * as path from './path.js';
import { URI } from './uri.js';

export function isEqual(first: URI | undefined, second: URI | undefined): boolean {
  return first === second || (!!first && !!second && first.toString() === second.toString());
}

export function joinPath(resource: URI, ...fragments: string[]): URI {
  return URI.joinPath(resource, ...fragments);
}

export function dirname(resource: URI): URI {
  return resource.path ? resource.with({ path: path.dirname(resource.path) }) : resource;
}

export function basename(resource: URI): string {
  return path.basename(resource.path);
}

export function extname(resource: URI): string {
  return path.extname(resource.path);
}

export function normalizePath(resource: URI): URI {
  return resource.path ? resource.with({ path: path.normalize(resource.path) }) : resource;
}

export function relativePath(from: URI, to: URI): string | undefined {
  if (from.scheme !== to.scheme || !isEqualAuthority(from, to)) {
    return undefined;
  }
  return path.relative(from.path || '/', to.path || '/');
}

export function isEqualOrParent(resource: URI, parent: URI): boolean {
  if (resource.scheme !== parent.scheme || !isEqualAuthority(resource, parent)
    || resource.query !== parent.query || resource.fragment !== parent.fragment) {
    return false;
  }
  const prefix = parent.path.endsWith('/') ? parent.path : parent.path + '/';
  return resource.path === parent.path || resource.path.startsWith(prefix);
}

function isEqualAuthority(first: URI, second: URI): boolean {
  return first.authority.toLowerCase() === second.authority.toLowerCase();
}
