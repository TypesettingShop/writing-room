import { expect, it, vi } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { InMemoryStorageDatabase } from '../../../../../base/parts/storage/common/storage.js';
import { InMemoryStorageService, storageKey, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { userExtensionsKey } from '../../../../services/extensionManagement/browser/webExtensionsScannerService.js';
import { NullExtensionService } from '../../../../services/extensions/common/extensions.js';
import type { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { WebviewStateStore } from '../../../webview/browser/webviewStateStore.js';
import { WebviewPanelRestoreService } from '../../browser/webviewPanelRestoreService.js';

it('keeps state across unregister, failed removal and reinstall, then prunes after a committed removal', async () => {
  const owner = 'fixture.owner';
  const record = (version: string) => JSON.stringify([{ identifier: owner, version }]);
  const stateAddress = storageKey(StorageScope.WORKSPACE, 'webview.states.v1');
  const database = new InMemoryStorageDatabase();
  const storage = new InMemoryStorageService(database);
  const states = new WebviewStateStore(storage);
  const changed = new Emitter<void>();
  const descriptions = [
    { identifier: { value: owner } }, { identifier: { value: 'fixture.builtin' } },
  ] as unknown as NonNullable<IExtensionService['extensions']>;
  let registered = descriptions;
  const extensions = Object.assign(new NullExtensionService(), { onDidChangeExtensions: changed.event });
  const service = new WebviewPanelRestoreService(Object.defineProperty(extensions, 'extensions', {
    get: () => registered,
  }), states, storage);
  const write = (raw: string) =>
    storage.storeImmediately(userExtensionsKey, raw, StorageScope.PROFILE, StorageTarget.USER);

  try {
    write(record('1.0.0'));
    states.set('panel', owner, '1');
    states.set('builtin', 'fixture.builtin', '2');
    await extensions.whenInstalledExtensionsRegistered();
    const saved = database.getItems().get(stateAddress);
    const unregisterOwner = () => {
      registered = descriptions.slice(1);
      changed.fire();
    };
    const registerOwner = () => {
      registered = descriptions;
      changed.fire();
    };

    unregisterOwner();
    expect(database.getItems().get(stateAddress)).toBe(saved);
    const failedWrite = vi.spyOn(database, 'updateItems')
      .mockImplementationOnce(() => { throw new Error('installed list write failed'); });
    expect(() => write('[]')).toThrow('installed list write failed');
    failedWrite.mockRestore();
    registerOwner();
    expect(database.getItems().get(stateAddress)).toBe(saved);

    unregisterOwner();
    write(record('2.0.0'));
    expect(database.getItems().get(stateAddress)).toBe(saved);
    registerOwner();

    unregisterOwner();
    expect(database.getItems().get(stateAddress)).toBe(saved);
    write('[]');
    expect(JSON.parse(database.getItems().get(stateAddress)!))
      .toEqual([{ id: 'builtin', extension: 'fixture.builtin', state: '2' }]);
  } finally {
    service.dispose();
    changed.dispose();
    storage.dispose();
  }
});
