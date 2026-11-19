import { describe, expect, test } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { isInsideRoots, resolveDialogPath, validateFileName } from '../../common/dialogPaths.js';

const root = URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace' });
const docs = URI.joinPath(root, 'docs');

describe('file names', () => {
  test.each([
    ['notes.md', undefined],
    ['', /must be provided/],
    ['.', /not valid/],
    ['..', /not valid/],
    ['a/b', /not valid/],
    ['a\\b', /not valid/],
    ['tab\there', /not valid/],
    ['bell\u0007', /not valid/],
    ['x'.repeat(255), undefined],
    ['x'.repeat(256), /longer than 255/],
  ])('%j', (name, expected) => {
    const message = validateFileName(name);
    if (expected === undefined) {
      expect(message).toBeUndefined();
    } else {
      expect(message).toMatch(expected);
    }
  });
});

describe('typed paths', () => {
  const resolve = (typed: string) => resolveDialogPath(typed, docs, [root]);

  test('reads a path relative to the folder, or absolute, with . and .. resolved', () => {
    expect(resolve('a.md')).toEqual({ resource: URI.joinPath(docs, 'a.md'), folder: false });
    expect(resolve('./sub/../b.md')).toEqual({ resource: URI.joinPath(docs, 'b.md'), folder: false });
    expect(resolve('/workspace/top.md')).toEqual({ resource: URI.joinPath(root, 'top.md'), folder: false });
    expect(resolve('..')).toEqual({ resource: root, folder: true });
    expect(resolve('sub/')).toEqual({ resource: URI.joinPath(docs, 'sub'), folder: true });
  });

  test('refuses what leaves the workspace folder once normalized, however it is spelled', () => {
    for (const typed of ['../..', '../../etc/passwd', '/etc/passwd', '/workspace/../secret', '/', '/workspace2/a.md', '../../workspace-other/a.md']) {
      expect(resolve(typed), typed).toBe('The path must be inside the workspace folder.');
    }
    // `..` that stays inside is fine.
    expect(resolve('../docs/../a.md')).toEqual({ resource: URI.joinPath(root, 'a.md'), folder: false });
  });

  test('refuses backslashes, control characters, empty input and names over 255 characters', () => {
    expect(resolve('a\\..\\..\\b')).toMatch(/cannot hold/);
    expect(resolve('a\u0000.md')).toMatch(/cannot hold/);
    expect(resolve('   ')).toBe('Please enter a valid path.');
    expect(resolve('x'.repeat(256))).toMatch(/longer than 255/);
    expect(resolve('x'.repeat(255))).toEqual({ resource: URI.joinPath(docs, 'x'.repeat(255)), folder: false });
  });

  test('a resource is inside only with the same scheme and authority', () => {
    expect(isInsideRoots(URI.joinPath(root, 'a'), [root])).toBe(true);
    expect(isInsideRoots(root.with({ scheme: 'file' }), [root])).toBe(false);
    expect(isInsideRoots(root.with({ authority: 'other' }), [root])).toBe(false);
    expect(isInsideRoots(root.with({ path: '/workspaces' }), [root])).toBe(false);
  });
});
