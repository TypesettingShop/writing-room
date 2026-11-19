import { normalize } from '../../../../base/common/path.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

/** The longest file or folder name, in UTF-16 code units, as most file systems allow. */
export const MAX_FILE_NAME_LENGTH = 255;

/** A backslash or a control character: no name or path here may hold one. */
const FORBIDDEN_IN_PATH = /[\\\p{Cc}]/u;

/** Whether `path` holds a backslash or a control character, which no workspace path may. */
export function hasForbiddenPathCharacter(path: string): boolean {
  return FORBIDDEN_IN_PATH.test(path);
}

/** Why `name` cannot name a file or folder, or `undefined` when it can. */
export function validateFileName(name: string): string | undefined {
  if (!name) {
    return 'A file or folder name must be provided.';
  }
  if (name === '.' || name === '..' || name.includes('/') || FORBIDDEN_IN_PATH.test(name)) {
    return 'This name is not valid as a file or folder name: it cannot be "." or "..", or hold "/", "\\" or control characters.';
  }
  if (name.length > MAX_FILE_NAME_LENGTH) {
    return `The name is longer than ${MAX_FILE_NAME_LENGTH} characters.`;
  }
  return undefined;
}

export interface IDialogPath {
  readonly resource: URI;
  /** The path was typed as a folder: it ends with `/`, `.` or `..`. */
  readonly folder: boolean;
}

/**
 * Reads a path typed into a file dialog: absolute (`/workspace/notes.md`, a path of `base`'s file
 * system) or relative to the folder `base`. `.` and `..` are resolved first; the result must then be
 * inside one of `roots`. Gives the resource, or why the path is not taken.
 */
export function resolveDialogPath(typed: string, base: URI, roots: readonly URI[]): IDialogPath | string {
  if (!typed.trim()) {
    return 'Please enter a valid path.';
  }
  if (FORBIDDEN_IN_PATH.test(typed)) {
    return 'A path cannot hold "\\" or control characters.';
  }
  const joined = typed.startsWith('/') ? typed : base.path.replace(/\/+$/, '') + '/' + typed;
  const path = normalize(joined);
  if (path.split('/').some(name => name.length > MAX_FILE_NAME_LENGTH)) {
    return `A name in the path is longer than ${MAX_FILE_NAME_LENGTH} characters.`;
  }
  const resource = URI.from({ scheme: base.scheme, authority: base.authority, path });
  if (!roots.some(root => isEqualOrParent(resource, root))) {
    return 'The path must be inside the workspace folder.';
  }
  return { resource, folder: /(?:^|\/)\.{0,2}$/.test(typed) };
}

/** Whether `resource` is one of `roots` or inside one, with the same scheme and authority. */
export function isInsideRoots(resource: URI, roots: readonly URI[]): boolean {
  return roots.some(root => isEqualOrParent(resource, root));
}
