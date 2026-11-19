import type { URI } from './uri.js';

export function isEqual(first: URI | undefined, second: URI | undefined): boolean {
  return first === second || (!!first && !!second && first.toString() === second.toString());
}

/** The last segment of the resource's path. */
export function basename(resource: URI): string {
  return resource.path.slice(resource.path.lastIndexOf('/') + 1);
}
