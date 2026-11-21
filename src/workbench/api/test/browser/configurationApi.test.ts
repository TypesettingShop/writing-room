// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { InMemoryStorageDatabase } from '../../../../base/parts/storage/common/storage.js';
import { URI } from '../../../../base/common/uri.js';
import type { IConfigurationData } from '../../../../platform/configuration/common/configurationModels.js';
import { ConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ConfigurationService, userSettingsKey } from '../../../services/configuration/browser/configurationService.js';
import { MainThreadConfiguration } from '../../browser/mainThreadConfiguration.js';
import { ExtHostConfigurationProxy, MainThreadConfigurationProxy } from '../../common/extHost.protocol.configuration.js';
import { ConfigurationTarget, ExtHostConfiguration } from '../../common/extHostConfiguration.js';
import { createTestRpcPair } from '../common/testExtensionHost.js';

let disposables: DisposableStore;
let registry: ConfigurationRegistry;
let storage: InMemoryStorageService;
let service: ConfigurationService;
let host: ExtHostConfiguration;
const registered = new Set(['1', '2']);

const settings = '{\n  // mine\n  "markdown.preview.fontSize": 15,\n  "unknown.key": [1,],\n}\n';

async function start(text = settings): Promise<void> {
  storage.storeImmediately(userSettingsKey, text, StorageScope.PROFILE, StorageTarget.USER);
  service = disposables.add(new ConfigurationService(registry, storage));
  const pair = createTestRpcPair();
  disposables.add({ dispose: () => pair.dispose() });
  const main = new MainThreadConfiguration(pair.main.getProxy(ExtHostConfigurationProxy), service, key => registered.has(key));
  disposables.add(main);
  pair.main.set(MainThreadConfigurationProxy, main);
  host = new ExtHostConfiguration(pair.worker.getProxy(MainThreadConfigurationProxy));
  disposables.add(host);
  pair.worker.set(ExtHostConfigurationProxy, host);
  await host.whenInitialized;
}

function text(): string {
  return storage.get(userSettingsKey, StorageScope.PROFILE)!;
}

function nextChange(extension = '1'): Promise<vscode.ConfigurationChangeEvent> {
  return new Promise(resolve => {
    const listener = host.onDidChangeConfiguration(extension)(event => {
      listener.dispose();
      resolve(event);
    });
  });
}

beforeEach(() => {
  disposables = new DisposableStore();
  storage = disposables.add(new InMemoryStorageService(new InMemoryStorageDatabase()));
  registry = new ConfigurationRegistry();
  registry.registerConfiguration({
    id: 'markdown', properties: {
      'markdown.preview.fontSize': { type: 'number', default: 14 },
      'markdown.preview.breaks': { type: 'boolean', default: false },
      'markdown.validate.enabled': { type: 'boolean', default: false },
      'markdownlint.config': { type: 'object', default: { default: true } },
      'editor.wordWrap': { type: 'string', enum: ['off', 'on'], default: 'off' },
      'editor.fontSize': { type: 'number', default: 14 },
    },
  });
  registry.registerDefaultConfigurations([{ overrides: { '[markdown]': { 'editor.wordWrap': 'on' } }, source: 'vscode.markdown' }]);
});

afterEach(() => disposables.dispose());

test('reads the copy synchronously, for the language of a document or a language scope only', async () => {
  await start('{ "editor.fontSize": 12, "[markdown]": { "editor.fontSize": 18 } }');
  const document = { uri: URI.parse('vscode-vfs://writing-room/workspace/a.md'), languageId: 'markdown' };
  expect(host.getConfiguration('1', 'editor', document as unknown as vscode.TextDocument).get('wordWrap')).toBe('on');
  expect(host.getConfiguration('1', 'editor', { languageId: 'markdown' }).get('fontSize')).toBe(18);
  expect(host.getConfiguration('1', 'editor', { languageId: 'plaintext' }).get('wordWrap')).toBe('off');
  expect(host.getConfiguration('1', 'editor', document.uri as unknown as vscode.Uri).get('fontSize')).toBe(12);
  const editor = host.getConfiguration('1', 'editor');
  expect(editor.get('fontSize')).toBe(12);
  expect(editor.fontSize).toBe(12);
  expect(editor.has('wordWrap')).toBe(true);
  expect(editor.has('missing')).toBe(false);
  expect(editor.get('missing', 'fallback')).toBe('fallback');
  expect(host.getConfiguration('1').get('markdown.preview.fontSize')).toBe(14);
  expect(host.getConfiguration('1', 'markdownlint').get('config.default')).toBe(true);
  expect(host.getConfiguration('1', 'editor').get('toString')).toBeUndefined();
  expect(host.getConfiguration('1', 'editor', { languageId: 'markdown' }).inspect('fontSize')).toEqual({
    key: 'editor.fontSize', defaultValue: 14, globalValue: 12, workspaceValue: undefined, workspaceFolderValue: undefined,
    defaultLanguageValue: undefined, globalLanguageValue: 18, workspaceLanguageValue: undefined,
    workspaceFolderLanguageValue: undefined, languageIds: ['markdown'],
  });
});

test('gives frozen copies that cannot change the copy or what the next read returns', async () => {
  await start();
  const lint = host.getConfiguration('1', 'markdownlint');
  const config = lint.get<Record<string, unknown>>('config')!;
  expect(() => { config.extra = 1; }).toThrow(TypeError);
  expect(() => { (lint as unknown as Record<string, unknown>).config = {}; }).toThrow(TypeError);
  expect(Object.isFrozen(lint.config)).toBe(true);
  expect(host.getConfiguration('1', 'markdownlint').get('config')).toEqual({ default: true });
});

test('writes one key into settings.json and reads the new value as soon as the write settles', async () => {
  await start();
  const changed = nextChange();
  await host.getConfiguration('1', 'markdown').update('preview.breaks', true);
  expect(host.getConfiguration('1', 'markdown').get('preview.breaks')).toBe(true);
  expect(text()).toBe('{\n  // mine\n  "markdown.preview.fontSize": 15,\n  "unknown.key": [1,],\n  "markdown.preview.breaks": true,\n}\n');
  expect((await changed).affectsConfiguration('markdown.preview.breaks')).toBe(true);

  await host.getConfiguration('1', 'markdown').update('preview.fontSize', undefined, ConfigurationTarget.Global);
  expect(text()).toBe('{\n  // mine\n  "unknown.key": [1,],\n  "markdown.preview.breaks": true,\n}\n');
  expect(host.getConfiguration('1').get('markdown.preview.fontSize')).toBe(14);
});

test('a listener reads the new value, and the event tells sections and languages apart', async () => {
  await start();
  const seen: unknown[] = [];
  host.onDidChangeConfiguration('1')(() => seen.push(host.getConfiguration('1', 'markdown.preview').get('fontSize')));
  let changed = nextChange();
  storage.storeImmediately(userSettingsKey, '{ "markdown.preview.fontSize": 20 }', StorageScope.PROFILE, StorageTarget.USER);
  let event = await changed;
  expect(seen).toEqual([20]);
  expect(event.affectsConfiguration('markdown')).toBe(true);
  expect(event.affectsConfiguration('markdown.preview')).toBe(true);
  expect(event.affectsConfiguration('markdown.preview.fontSize')).toBe(true);
  expect(event.affectsConfiguration('markdown.validate')).toBe(false);
  expect(event.affectsConfiguration('markdownlint')).toBe(false);
  expect(event.affectsConfiguration('editor', { languageId: 'markdown' })).toBe(false);

  changed = nextChange();
  storage.storeImmediately(userSettingsKey, '{ "markdown.preview.fontSize": 20, "[markdown]": { "editor.fontSize": 9 } }',
    StorageScope.PROFILE, StorageTarget.USER);
  event = await changed;
  expect(event.affectsConfiguration('editor')).toBe(true);
  expect(event.affectsConfiguration('editor', { languageId: 'markdown' })).toBe(true);
  expect(event.affectsConfiguration('editor.fontSize', { uri: URI.parse('vscode-vfs://writing-room/workspace/a.md'), languageId: 'markdown' } as never))
    .toBe(true);
  expect(event.affectsConfiguration('editor', { languageId: 'plaintext' })).toBe(false);
  expect(event.affectsConfiguration('editor.wordWrap', { languageId: 'markdown' })).toBe(false);
  expect(event.affectsConfiguration('markdown')).toBe(false);
});

test('two extensions writing different keys in a row both keep their values', async () => {
  await start();
  await Promise.all([
    host.getConfiguration('1', 'markdown').update('validate.enabled', true),
    host.getConfiguration('2', 'markdownlint').update('config', { MD013: false }),
  ]);
  expect(host.getConfiguration('1').get('markdown.validate.enabled')).toBe(true);
  expect(host.getConfiguration('2').get('markdownlint.config')).toEqual({ MD013: false });
  expect(text()).toContain('// mine');
  expect(text()).toContain('"unknown.key": [1,]');
});

test('refuses workspace targets, unregistered keys, values that are not JSON and unknown extensions', async () => {
  await start();
  const markdown = host.getConfiguration('1', 'markdown');
  await expect(markdown.update('preview.breaks', true, ConfigurationTarget.Workspace)).rejects.toThrow('does not support workspace settings');
  await expect(markdown.update('preview.breaks', true, false)).rejects.toThrow('Unable to write to Workspace Settings');
  await expect(markdown.update('preview.breaks', true, ConfigurationTarget.WorkspaceFolder)).rejects.toThrow('Unable to write to Folder Settings');
  await expect(markdown.update('nothing', 1)).rejects.toThrow('markdown.nothing is not a registered configuration');
  await expect(markdown.update('preview.fontSize', () => 1)).rejects.toThrow('JSON data');
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await expect(host.getConfiguration('1').update('markdownlint.config', cycle)).rejects.toThrow('JSON data');
  await expect(host.getConfiguration('3', 'markdown').update('preview.breaks', true)).rejects.toThrow('not registered');
  expect(text()).toBe(settings);
});

test('writes for the language when asked, or where the user already has a value for it', async () => {
  await start('{\n}\n');
  const markdown = { languageId: 'markdown' };
  await host.getConfiguration('1', 'editor', markdown).update('fontSize', 20);
  expect(JSON.parse(text())).toEqual({ 'editor.fontSize': 20 });
  await host.getConfiguration('1', 'editor', markdown).update('fontSize', 22, true, true);
  expect(JSON.parse(text())).toEqual({ 'editor.fontSize': 20, '[markdown]': { 'editor.fontSize': 22 } });
  await host.getConfiguration('1', 'editor', markdown).update('fontSize', 24);
  expect(JSON.parse(text())).toEqual({ 'editor.fontSize': 20, '[markdown]': { 'editor.fontSize': 24 } });
  await host.getConfiguration('1', 'editor', markdown).update('fontSize', 26, null, false);
  expect(JSON.parse(text())).toEqual({ 'editor.fontSize': 26, '[markdown]': { 'editor.fontSize': 24 } });
  expect(host.getConfiguration('1', 'editor', markdown).get('fontSize')).toBe(24);
  await host.getConfiguration('1', 'editor', markdown).update('fontSize', undefined, true, true);
  expect(JSON.parse(text())).toEqual({ 'editor.fontSize': 26, '[markdown]': {} });
});

test('fires when a default changes, and stops for an extension that was released', async () => {
  await start();
  const listener = vi.fn();
  host.onDidChangeConfiguration('2')(listener);
  const changed = nextChange();
  registry.registerConfiguration({ id: 'late', properties: { 'late.enabled': { type: 'boolean', default: true } } });
  expect((await changed).affectsConfiguration('late')).toBe(true);
  expect(host.getConfiguration('1').get('late.enabled')).toBe(true);
  expect(listener).toHaveBeenCalledOnce();

  host.release('2');
  const again = nextChange();
  registry.registerDefaultConfigurations([{ overrides: { 'late.enabled': false } }]);
  await again;
  expect(host.getConfiguration('1').get('late.enabled')).toBe(false);
  expect(listener).toHaveBeenCalledOnce();
});

test('drops a change that arrives before the first data, which already holds it', async () => {
  let answer!: (data: IConfigurationData) => void;
  const early = new ExtHostConfiguration({
    $getConfigurationData: () => new Promise(resolve => { answer = resolve; }),
    $updateConfigurationOption: async () => {},
    $removeConfigurationOption: async () => {},
  });
  disposables.add(early);
  const listener = vi.fn();
  early.onDidChangeConfiguration('1')(listener);
  await early.$acceptConfigurationChanged([['editor.fontSize', { default: 14, user: 99 }]]);
  answer([['editor.fontSize', { default: 14, user: 12 }]]);
  await early.whenInitialized;
  expect(early.getConfiguration('1', 'editor').get('fontSize')).toBe(12);
  expect(listener).not.toHaveBeenCalled();
});
