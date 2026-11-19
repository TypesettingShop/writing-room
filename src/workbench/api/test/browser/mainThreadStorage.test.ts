import { expect, test } from 'vitest';
import type { IFileService } from '../../../../platform/files/common/files.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ExtensionStorage } from '../../browser/mainThreadStorage.js';

test('serializes writes and rejects per-extension and aggregate overflow without changing old state', async () => {
  const storage = new InMemoryStorageService();
  const state = new ExtensionStorage(storage, {} as IFileService, {} as IWorkspaceContextService);
  const write = (id: string, name: string, json: string) => state.update(id, 'global', name, json, () => true);
  try {
    await Promise.all([write('test.first', 'one', '1'), write('test.first', 'two', '2')]);
    await expect(write('test.first', 'one', JSON.stringify('한'.repeat(100_000)))).rejects.toThrow('256 KiB');
    expect(JSON.parse(state.read('test.first', 'global'))).toEqual({ one: 1, two: 2 });

    const value = JSON.stringify('x'.repeat(250 * 1024));
    await Promise.all(Array.from({ length: 8 }, (_, index) => write(`test.large${index}`, 'value', value)));
    await expect(write('test.first', 'another', value)).rejects.toThrow('2 MiB');
    expect(JSON.parse(state.read('test.first', 'global'))).toEqual({ one: 1, two: 2 });
    expect(storage.get('extensions.state.test.first', StorageScope.WORKSPACE)).toBeUndefined();
  } finally {
    state.dispose();
    storage.dispose();
  }
});

test('rejects a late writer from an uninstalled generation', async () => {
  const storage = new InMemoryStorageService();
  const state = new ExtensionStorage(storage, {} as IFileService, {} as IWorkspaceContextService);
  const installation = { identifier: 'test.sample', installedAt: 1, location: 'https://example.test/' };
  try {
    storage.storeImmediately('extensions.user', JSON.stringify([installation]), StorageScope.PROFILE, StorageTarget.USER);
    await state.update(installation.identifier, 'global', 'name', '"before"', () => true, installation);
    storage.storeImmediately('extensions.user', '[]', StorageScope.PROFILE, StorageTarget.USER);
    await expect(state.update(installation.identifier, 'global', 'name', '"after"', () => true, installation))
      .rejects.toThrow('is no longer installed');
    expect(JSON.parse(state.read(installation.identifier, 'global'))).toEqual({ name: 'before' });
  } finally {
    state.dispose();
    storage.dispose();
  }
});
