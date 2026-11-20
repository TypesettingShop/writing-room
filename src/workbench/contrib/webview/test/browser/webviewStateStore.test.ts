import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryStorageDatabase } from '../../../../../base/parts/storage/common/storage.js';
import { InMemoryStorageService, storageKey, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { userExtensionsKey } from '../../../../services/extensionManagement/browser/webExtensionsScannerService.js';
import { WebviewStateStore } from '../../browser/webviewStateStore.js';

it('preserves earlier states and warns once when a pane or the workspace exceeds its byte budget', () => {
  const storage = new InMemoryStorageService();
  const states = new WebviewStateStore(storage);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const owner = 'fixture.owner';
  const large = JSON.stringify('a'.repeat(256 * 1024 - 2));
  try {
    states.set('first', owner, 'false');
    states.set('first', owner, JSON.stringify('가'.repeat(256 * 1024 / 3)));
    expect(states.get('first', owner)).toBe('false');
    for (let i = 0; i < 4; i++) {
      states.set(String(i), owner, large);
    }
    expect(states.get('2', owner)).toBe(large);
    expect(states.get('3', owner)).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    warning.mockRestore();
    storage.dispose();
  }
});

it('checks the owning extension and ignores malformed stored JSON', () => {
  const storage = new InMemoryStorageService();
  const states = new WebviewStateStore(storage);
  try {
    storage.store('webview.states.v1', JSON.stringify([{ id: 'broken', extension: 'fixture.owner', state: '[' }]),
      StorageScope.WORKSPACE, StorageTarget.MACHINE);
    expect(states.get('broken', 'fixture.owner')).toBeUndefined();
    states.set('id', 'fixture.owner', '0');
    states.set('id', 'fixture.other', 'true');
    expect(states.get('id', 'fixture.owner')).toBe('0');
    expect(states.get('id', 'fixture.other')).toBe('true');
    states.removeMissingExtensions(new Set(['fixture.other']));
    expect(states.get('id', 'fixture.owner')).toBeUndefined();
    expect(states.get('id', 'fixture.other')).toBe('true');
    states.delete('id', 'fixture.other');
    expect(states.get('id', 'fixture.other')).toBeUndefined();
  } finally {
    storage.dispose();
  }
});

const installedAddress = storageKey(StorageScope.PROFILE, userExtensionsKey);
const stateAddress = storageKey(StorageScope.WORKSPACE, 'webview.states.v1');
const owner = 'fixture.owner';

afterEach(() => vi.restoreAllMocks());

it('mutates only this tab after a flush failure, even when the persistent backend works again', async () => {
  const database = new InMemoryStorageDatabase();
  const storage = new InMemoryStorageService(database);
  const states = new WebviewStateStore(storage);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    states.set('set', owner, '0');
    states.set('close', owner, '1');
    states.set('prune', 'fixture.other', '2');
    const saved = database.getItems().get(stateAddress);
    vi.spyOn(database, 'updateItems').mockImplementationOnce(() => { throw new Error('write blocked'); });
    storage.store('trigger', true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
    await storage.flush();
    expect(storage.usesMemory).toBe(true);
    const immediate = vi.spyOn(storage, 'storeImmediately');
    const readBackend = vi.spyOn(database, 'getItems');

    states.set('set', owner, '3');
    expect(states.get('set', owner)).toBe('3');
    states.delete('close', owner);
    expect(states.get('close', owner)).toBeUndefined();
    states.removeMissingExtensions(new Set([owner]));
    expect(states.get('prune', 'fixture.other')).toBeUndefined();
    await storage.flush();

    expect(immediate).not.toHaveBeenCalled();
    expect(readBackend).not.toHaveBeenCalled();
    expect(database.getItems().get(stateAddress)).toBe(saved);
  } finally {
    storage.dispose();
  }
});

it('saves, enforces both limits and deletes in a tab whose backend never opens', () => {
  const database = new InMemoryStorageDatabase();
  vi.spyOn(database, 'getItems').mockImplementation(() => { throw new Error('read blocked'); });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = new InMemoryStorageService(database);
  const states = new WebviewStateStore(storage);
  try {
    expect(storage.usesMemory).toBe(true);
    warning.mockClear();
    states.set('first', owner, 'false');
    expect(states.get('first', owner)).toBe('false');
    expect(warning).not.toHaveBeenCalled();
    states.set('first', owner, JSON.stringify('가'.repeat(256 * 1024 / 3)));
    expect(states.get('first', owner)).toBe('false');
    const large = JSON.stringify('a'.repeat(256 * 1024 - 2));
    for (let i = 0; i < 4; i++) {
      states.set(String(i), owner, large);
    }
    expect(states.get('2', owner)).toBe(large);
    expect(states.get('3', owner)).toBeUndefined();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'Webview state could not be saved. The limits are 256 KiB per webview and 1 MiB per workspace.',
    );
    states.delete('first', owner);
    expect(states.get('first', owner)).toBeUndefined();
    states.removeMissingExtensions(new Set());
    expect(states.get('2', owner)).toBeUndefined();
  } finally {
    storage.dispose();
  }
});

it('merges writes with the persisted state even while this tab has a stale cache', () => {
  const database = new InMemoryStorageDatabase();
  const storage = new InMemoryStorageService(database);
  const states = new WebviewStateStore(storage);
  try {
    const fromAnotherTab = { id: 'another', extension: owner, state: '1' };
    database.updateItems({
      insert: new Map([[stateAddress, JSON.stringify([fromAnotherTab])]]), delete: new Set(),
    });
    expect(states.get('another', owner)).toBeUndefined();
    states.set('local', owner, '2');
    expect(database.getItems().get(stateAddress)).toBe(JSON.stringify([
      fromAnotherTab, { id: 'local', extension: owner, state: '2' },
    ]));
  } finally {
    storage.dispose();
  }
});

it('drops failed persistent writes and warns with the backend error once', () => {
  const database = new InMemoryStorageDatabase();
  const storage = new InMemoryStorageService(database);
  const states = new WebviewStateStore(storage);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    states.set('id', owner, '0');
    const saved = database.getItems().get(stateAddress);
    const error = new Error('quota exhausted');
    vi.spyOn(database, 'updateItems').mockImplementation(() => { throw error; });
    states.set('id', owner, '1');
    states.set('id', owner, '2');
    expect(states.get('id', owner)).toBe('0');
    expect(database.getItems().get(stateAddress)).toBe(saved);
    expect(storage.usesMemory).toBe(false);
    expect(warning).toHaveBeenCalledExactlyOnceWith('Webview state could not be saved.', error);
  } finally {
    storage.dispose();
  }
});

it('prunes only unregistered owners absent from the same persisted snapshot of the installation list', () => {
  const database = new InMemoryStorageDatabase();
  const storage = new InMemoryStorageService(database);
  const states = new WebviewStateStore(storage);
  try {
    const records = JSON.stringify([{ identifier: 'Fixture.Owner', location: 'invalid' }, null, 8]);
    database.updateItems({ insert: new Map([[installedAddress, records]]), delete: new Set() });
    expect(storage.get(userExtensionsKey, StorageScope.PROFILE)).toBeUndefined();
    const readBackend = vi.spyOn(database, 'getItems');
    states.set('other-tab', owner, '1');
    states.set('registered', 'fixture.builtin', '2');
    states.set('orphan', 'fixture.orphan', '3');
    readBackend.mockClear();

    states.removeMissingExtensions(new Set(['fixture.builtin']));

    expect(readBackend).toHaveBeenCalledTimes(1);
    expect(JSON.parse(database.getItems().get(stateAddress)!)).toEqual([
      { id: 'other-tab', extension: owner, state: '1' },
      { id: 'registered', extension: 'fixture.builtin', state: '2' },
    ]);
  } finally {
    storage.dispose();
  }
});

it.each(['', '{', '{}'])('preserves state while the recorded list %j is unreadable', raw => {
  const database = new InMemoryStorageDatabase();
  const storage = new InMemoryStorageService(database);
  const states = new WebviewStateStore(storage);
  try {
    states.set('pane', owner, '1');
    const saved = database.getItems().get(stateAddress);
    storage.storeImmediately(userExtensionsKey, raw, StorageScope.PROFILE, StorageTarget.USER);

    states.removeMissingExtensions(new Set());

    expect(states.get('pane', owner)).toBe('1');
    expect(database.getItems().get(stateAddress)).toBe(saved);
  } finally {
    storage.dispose();
  }
});

it('uses the installation list in this tab after falling back to memory', async () => {
  const database = new InMemoryStorageDatabase();
  const storage = new InMemoryStorageService(database);
  const states = new WebviewStateStore(storage);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    states.set('saved-owner', owner, '1');
    states.set('tab-owner', 'fixture.tab', '2');
    storage.storeImmediately(userExtensionsKey, JSON.stringify([{ identifier: owner }]), StorageScope.PROFILE, StorageTarget.USER);
    const saved = database.getItems();
    vi.spyOn(database, 'updateItems').mockImplementationOnce(() => { throw new Error('write blocked'); });
    storage.store(userExtensionsKey, JSON.stringify([{ identifier: 'fixture.tab' }]), StorageScope.PROFILE, StorageTarget.USER);
    await storage.flush();
    expect(storage.usesMemory).toBe(true);
    const readBackend = vi.spyOn(database, 'getItems');

    states.removeMissingExtensions(new Set());

    expect(states.get('saved-owner', owner)).toBeUndefined();
    expect(states.get('tab-owner', 'fixture.tab')).toBe('2');
    expect(readBackend).not.toHaveBeenCalled();
    expect(database.getItems()).toEqual(saved);
  } finally {
    storage.dispose();
  }
});

it('writes nothing when every saved owner is still registered or recorded', () => {
  const database = new InMemoryStorageDatabase();
  const storage = new InMemoryStorageService(database);
  const states = new WebviewStateStore(storage);
  try {
    storage.storeImmediately(userExtensionsKey, JSON.stringify([{ identifier: owner }]), StorageScope.PROFILE, StorageTarget.USER);
    states.set('recorded', owner, '1');
    states.set('registered', 'fixture.builtin', '2');
    const write = vi.spyOn(database, 'updateItems');

    states.removeMissingExtensions(new Set(['fixture.builtin']));

    expect(write).not.toHaveBeenCalled();
    expect(states.get('recorded', owner)).toBe('1');
    expect(states.get('registered', 'fixture.builtin')).toBe('2');
  } finally {
    storage.dispose();
  }
});
