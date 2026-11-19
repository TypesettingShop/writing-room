import { expect, test, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { findWorkspaceActivation } from '../../browser/workspaceActivation.js';

const root = URI.parse('vscode-vfs://writing-room/workspace');
const folder = { uri: root, name: 'workspace', index: 0, toResource: (path: string) => URI.joinPath(root, path) };

test('checks literal paths directly and walks glob matches only within the workspace', async () => {
  const readme = folder.toResource('README.md');
  const nested = folder.toResource('nested');
  const exists = vi.fn(async (resource: URI) => resource.path === readme.path);
  const resolve = vi.fn(async (resource: URI) => ({
    children: resource.path === root.path
      ? [{ resource: readme, isDirectory: false }, { resource: nested, isDirectory: true }]
      : [{ resource: folder.toResource('nested/notes.md'), isDirectory: false }],
  }));
  const files = { exists, resolve } as unknown as IFileService;
  const signal = new AbortController().signal;

  await expect(findWorkspaceActivation(files, [folder], 'README.md', signal)).resolves.toBe(true);
  await expect(findWorkspaceActivation(files, [folder], 'missing.txt', signal)).resolves.toBe(false);
  await expect(findWorkspaceActivation(files, [folder], '../README.md', signal)).resolves.toBe(false);
  expect(exists).toHaveBeenCalledTimes(2);
  expect(resolve).not.toHaveBeenCalled();
  await expect(findWorkspaceActivation(files, [folder], '**/notes.{md,txt}', signal)).resolves.toBe(true);
  expect(resolve.mock.calls.map(([uri]) => uri.path)).toEqual([root.path, nested.path]);
});

test('stops waiting for an in-flight directory lookup when the workbench closes', async () => {
  const files = { resolve: vi.fn(() => new Promise(() => {})) } as unknown as IFileService;
  const controller = new AbortController();
  const result = findWorkspaceActivation(files, [folder], '**/*.md', controller.signal);
  controller.abort();
  await expect(result).resolves.toBe(false);
});
