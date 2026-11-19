import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InMemoryStorageDatabase } from '../../../../../base/parts/storage/common/storage.js';
import type { IStorageUpdate } from '../../../../../base/parts/storage/common/storage.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { InMemoryStorageService, StorageScope, StorageTarget, storageKey } from '../../../../../platform/storage/common/storage.js';
import { ConfigurationService, userSettingsKey } from '../../browser/configurationService.js';

/** Opens like the browser backend: `getItems` opens it, and a closed backend drops writes. */
class TestDatabase extends InMemoryStorageDatabase {
  fail = false;
  open = false;

  override getItems(): Map<string, string> {
    this.open = true;
    return super.getItems();
  }

  override updateItems(update: IStorageUpdate): void {
    if (this.fail) {
      throw new Error('quota exceeded');
    }
    if (this.open) {
      super.updateItems(update);
    }
  }

  override close(): void {
    this.open = false;
  }

  /** Reads a persisted value without opening the backend. */
  peek(key: string): string | undefined {
    return super.getItems().get(key);
  }
}

class TestStorage extends InMemoryStorageService {
  receiveExternal(text: string | undefined): void {
    this.acceptExternalValue(storageKey(StorageScope.PROFILE, userSettingsKey), text);
  }
}

let disposables: DisposableStore;
let database: TestDatabase;
let storage: TestStorage;
let registry: ConfigurationRegistry;

beforeEach(() => {
  disposables = new DisposableStore();
  database = new TestDatabase();
  storage = disposables.add(new TestStorage(database));
  registry = new ConfigurationRegistry();
  registry.registerConfiguration({
    id: 'editor', title: 'Editor', properties: {
      'editor.fontSize': { type: 'number', minimum: 6, maximum: 100, default: 14, description: 'Size' },
      'editor.tabSize': { type: 'integer', minimum: 1, default: 4, description: 'Indent' },
      'editor.minimap.enabled': { type: 'boolean', default: true, description: 'Minimap' },
    },
  });
});
afterEach(() => disposables.dispose());

function start(text?: string): ConfigurationService {
  if (text !== undefined) {
    storage.storeImmediately(userSettingsKey, text, StorageScope.PROFILE, StorageTarget.USER);
  }
  return disposables.add(new ConfigurationService(registry, storage));
}

test('loads defaults and valid user values by key and section, retaining the exact text and unknown keys', () => {
  const raw = '{\r\n  // keep\r\n  "editor.fontSize": 23, "editor.tabSize": 1.5, "future": true,\r\n}';
  const service = start(raw);
  expect(service.getUserSettingsText()).toBe(raw);
  const editor = service.getValue<{ fontSize: number }>('editor')!;
  expect(editor).toEqual({ fontSize: 23, tabSize: 4, minimap: { enabled: true } });
  editor.fontSize = 42;
  expect(service.getValue('editor.fontSize')).toBe(23);
  expect(service.getValue('future')).toBeUndefined();
  expect(service.getValue('unknown.section')).toBeUndefined();
});

test('preserves the last valid value through syntax errors and applies settings registered later', async () => {
  const service = start('{ "editor.fontSize": 21, "future.key": true }');
  const changed = vi.fn();
  disposables.add(service.onDidChangeConfiguration(changed));
  service.saveUserSettings('{ syntax error');
  expect(service.getUserSettingsText()).toBe('{ syntax error');
  expect(service.getValue('editor.fontSize')).toBe(21);
  expect(changed).not.toHaveBeenCalled();
  await expect(service.updateValue('editor.fontSize', 22)).rejects.toThrow('Fix the syntax');
  expect(storage.get(userSettingsKey, StorageScope.PROFILE)).toBe('{ syntax error');
  registry.registerConfiguration({
    id: 'future', title: 'Future', properties: {
      'future.key': { type: 'boolean', default: false, description: 'Late' },
    },
  });
  expect(service.getValue('future.key')).toBe(true);
  expect(changed).toHaveBeenCalledOnce();
  const event = changed.mock.calls[0][0];
  expect(event.affectsConfiguration('future')).toBe(true);
  expect(event.affectsConfiguration('editor')).toBe(false);
});

test('updates one key in place and emits only effective changes as external values arrive', async () => {
  const raw = '{\n // keep\n "editor.fontSize": 19, "unknown": "unchanged",\n}';
  const service = start(raw);
  const changed = vi.fn();
  const rawChanged = vi.fn();
  disposables.add(service.onDidChangeConfiguration(changed));
  disposables.add(service.onDidChangeUserSettings(rawChanged));
  await service.updateValue('editor.fontSize', 20);
  expect(service.getUserSettingsText()).toBe(raw.replace('19', '20'));
  const event = changed.mock.calls[0][0];
  expect(event.affectsConfiguration('editor.fontSize')).toBe(true);
  expect(event.affectsConfiguration('editor')).toBe(true);
  expect(event.affectsConfiguration('editor.tabSize')).toBe(false);
  storage.receiveExternal(raw.replace('// keep', '// external').replace('19', '20'));
  expect(rawChanged).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledOnce();
  storage.receiveExternal('{"editor.fontSize": "wrong", "editor.minimap.enabled": false}');
  expect(service.getValue('editor.fontSize')).toBe(14);
  expect(service.getValue('editor.minimap.enabled')).toBe(false);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(changed.mock.calls[1][0].affectsConfiguration('editor.minimap')).toBe(true);
  await expect(service.updateValue('editor.tabSize', 0)).rejects.toThrow('Unsupported value');
});

test('a failed explicit write changes neither persisted data nor effective values and can be retried', () => {
  const raw = '{"editor.fontSize":20}';
  const service = start(raw);
  const changed = vi.fn();
  disposables.add(service.onDidChangeConfiguration(changed));
  database.fail = true;
  expect(() => service.saveUserSettings('{"editor.fontSize":24}')).toThrow('quota exceeded');
  expect(service.getUserSettingsText()).toBe(raw);
  expect(storage.get(userSettingsKey, StorageScope.PROFILE)).toBe(raw);
  expect(database.getItems().get(storageKey(StorageScope.PROFILE, userSettingsKey))).toBe(raw);
  expect(service.getValue('editor.fontSize')).toBe(20);
  expect(changed).not.toHaveBeenCalled();
  database.fail = false;
  service.saveUserSettings('{"editor.fontSize":24}');
  expect(service.getValue('editor.fontSize')).toBe(24);
  expect(changed).toHaveBeenCalledOnce();
});

test('publishes raw text and effective values in order when a listener saves again', () => {
  const service = start();
  const events: [string, unknown][] = [];
  const first = '{"editor.fontSize":20}';
  const second = '{"editor.fontSize":21}';
  disposables.add(service.onDidChangeConfiguration(() => {
    if (service.getValue('editor.fontSize') === 20) {
      service.saveUserSettings(second);
    }
  }));
  disposables.add(service.onDidChangeUserSettings(text => events.push([text, service.getValue('editor.fontSize')])));
  service.saveUserSettings(first);
  expect(events).toEqual([[first, 20], [second, 21]]);
});

test('edits persisted text newer than the local cache and preserves the other writer’s changes', async () => {
  const service = start('{"editor.fontSize":18}');
  const external = '{\n // written by another tab\n "editor.fontSize":19, "unknown":42,\n}';
  database.updateItems({
    insert: new Map([[storageKey(StorageScope.PROFILE, userSettingsKey), external]]),
    delete: new Set(),
  });
  await service.updateValue('editor.fontSize', 24);
  expect(service.getUserSettingsText()).toBe(external.replace('19', '24'));
});

test('an explicit settings write can retry the persistent backend after a background write fell back', async () => {
  const service = start('{"editor.fontSize":18}');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    database.fail = true;
    storage.store('session-state', 'unrelated', StorageScope.PROFILE, StorageTarget.USER);
    await storage.flush();
    expect(warn).toHaveBeenCalledOnce();
    expect(database.open).toBe(false);
    expect(() => service.saveUserSettings('{"editor.fontSize":21}')).toThrow('quota exceeded');
    expect(database.open).toBe(false);
    expect(service.getValue('editor.fontSize')).toBe(18);
    database.fail = false;
    service.saveUserSettings('{"editor.fontSize":21}');
    expect(service.getValue('editor.fontSize')).toBe(21);
    expect(database.peek(storageKey(StorageScope.PROFILE, userSettingsKey))).toBe('{"editor.fontSize":21}');
    // The tab's other state lives only in memory, so the backend stays closed to other tabs' writes.
    expect(database.open).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

test('writes a language value inside its section, creating it, and keeps comments, commas and unknown keys', async () => {
  const raw = '{\n  // mine\n  "editor.fontSize": 18,\n  "unknown": [1,],\n}\n';
  const service = start(raw);
  const changed = vi.fn();
  disposables.add(service.onDidChangeConfiguration(changed));
  await service.updateValue('editor.fontSize', 20, { overrideIdentifier: 'markdown' });
  expect(service.getUserSettingsText()).toBe('{\n  // mine\n  "editor.fontSize": 18,\n  "unknown": [1,],\n'
    + '  "[markdown]": {\n    "editor.fontSize": 20\n  },\n}\n');
  expect(service.getValue('editor.fontSize')).toBe(18);
  expect(service.getValue('editor.fontSize', { overrideIdentifier: 'markdown' })).toBe(20);
  const event = changed.mock.calls[0][0];
  expect(event.affectsConfiguration('editor.fontSize', { overrideIdentifier: 'markdown' })).toBe(true);
  expect(event.affectsConfiguration('editor.fontSize', { overrideIdentifier: 'plaintext' })).toBe(false);

  await service.updateValue('editor.tabSize', 2, { overrideIdentifier: 'markdown' });
  await service.updateValue('editor.fontSize', undefined, { overrideIdentifier: 'markdown' });
  expect(service.getUserSettingsText()).toBe('{\n  // mine\n  "editor.fontSize": 18,\n  "unknown": [1,],\n'
    + '  "[markdown]": {\n    "editor.tabSize": 2\n  },\n}\n');
  await service.updateValue('editor.fontSize', undefined);
  expect(service.getUserSettingsText()).toBe('{\n  // mine\n  "unknown": [1,],\n'
    + '  "[markdown]": {\n    "editor.tabSize": 2\n  },\n}\n');
  expect(service.inspect('editor.fontSize', { overrideIdentifier: 'markdown' })).toMatchObject({ value: 14, userValue: undefined });
});

test('two writers of different keys in a row both stay, and a key nobody registered is refused', async () => {
  const service = start('{\n}\n');
  await Promise.all([service.updateValue('editor.fontSize', 30), service.updateValue('editor.tabSize', 3)]);
  expect(service.getValue('editor')).toMatchObject({ fontSize: 30, tabSize: 3 });
  await expect(service.updateValue('future.key', true)).rejects.toThrow('future.key is not a registered configuration');
  await expect(service.updateValue('editor.fontSize', { size: 1 })).rejects.toThrow('Unsupported value');
});

test('a deregistered key reads as undefined with a change event, and its user value stays in the text', () => {
  const node = { id: 'late', properties: { 'late.value': { type: 'string', default: 'd' } } } as const;
  registry.registerConfiguration(node);
  const raw = '{ "late.value": "mine" }';
  const service = start(raw);
  const changed = vi.fn();
  disposables.add(service.onDidChangeConfiguration(changed));
  expect(service.getValue('late.value')).toBe('mine');
  registry.deregisterConfigurations([node]);
  expect(service.getValue('late.value')).toBeUndefined();
  expect(changed).toHaveBeenCalledOnce();
  expect(changed.mock.calls[0][0].affectsConfiguration('late')).toBe(true);
  expect(service.getUserSettingsText()).toBe(raw);
  registry.registerConfiguration(node);
  expect(service.getValue('late.value')).toBe('mine');
});

test('a default for a language changes the value for that language only and fires a change', () => {
  const service = start('{ "editor.fontSize": 16 }');
  const changed = vi.fn();
  disposables.add(service.onDidChangeConfiguration(changed));
  const defaults = { overrides: { '[markdown]': { 'editor.fontSize': 20 } }, source: 'ext' };
  registry.registerDefaultConfigurations([defaults]);
  expect(service.getValue('editor.fontSize', { overrideIdentifier: 'markdown' })).toBe(20);
  expect(service.getValue('editor.fontSize')).toBe(16);
  expect(changed).toHaveBeenCalledOnce();
  registry.deregisterDefaultConfigurations([defaults]);
  expect(service.getValue('editor.fontSize', { overrideIdentifier: 'markdown' })).toBe(16);
  expect(changed).toHaveBeenCalledTimes(2);
});
