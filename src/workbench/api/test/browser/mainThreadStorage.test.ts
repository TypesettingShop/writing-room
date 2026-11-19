import { expect, test, vi } from 'vitest';
import type { IFileService } from '../../../../platform/files/common/files.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ExtensionStorage } from '../../browser/mainThreadStorage.js';

test('rejects per-extension and aggregate overflow without changing old state', async () => {
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

test('queues a second write before it requests the browser lock', async () => {
  const storage = new InMemoryStorageService();
  const state = new ExtensionStorage(storage, {} as IFileService, {} as IWorkspaceContextService);
  let allowFirst!: () => void;
  const held = new Promise<void>(resolve => { allowFirst = resolve; });
  let calls = 0;
  const request = vi.fn(async (_name: string, callback: () => Promise<void>) => {
    if (++calls === 1) {
      await held;
    }
    return callback();
  });
  vi.stubGlobal('navigator', { locks: { request } });
  const first = state.update('test.sample', 'global', 'key', '"first"', () => true);
  const second = state.update('test.sample', 'global', 'key', '"second"', () => true);
  try {
    await Promise.resolve();
    expect(request).toHaveBeenCalledExactlyOnceWith('writing-room:extensions.state', expect.any(Function));
    expect(state.read('test.sample', 'global')).toBe('{}');
    allowFirst();
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(state.read('test.sample', 'global'))).toEqual({ key: 'second' });
  } finally {
    allowFirst();
    await Promise.allSettled([first, second]);
    vi.unstubAllGlobals();
    state.dispose();
    storage.dispose();
  }
});
