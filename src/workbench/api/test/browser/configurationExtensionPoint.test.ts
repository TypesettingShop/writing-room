// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { InMemoryStorageDatabase } from '../../../../base/parts/storage/common/storage.js';
import { configurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { IConfigurationNode } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../platform/extensions/common/extensions.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ConfigurationService, userSettingsKey } from '../../../services/configuration/browser/configurationService.js';
import { ExtensionMessageCollector, ExtensionsRegistry } from '../../../services/extensions/common/extensionsRegistry.js';
import type { ExtensionPointContext } from '../../../services/extensions/common/extensionsRegistry.js';
import '../../common/configurationExtensionPoint.js';

interface IFakeExtension {
  readonly id: string;
  readonly configuration?: unknown;
  readonly configurationDefaults?: unknown;
}

const fixture = JSON.parse(readFileSync(new URL('../../../../../test/fixtures/extensions/configuration/package.json', import.meta.url), 'utf8'));
const points = new Map(ExtensionsRegistry.getExtensionPoints().map(point => [point.name, point]));
const context = {} as ExtensionPointContext;

/** Does what the extension service does: drop the last registrations, then accept every point again. */
class Host {
  readonly messages: IExtensionMessage[] = [];
  private store = new DisposableStore();

  apply(extensions: readonly IFakeExtension[]): void {
    this.store.dispose();
    this.store = new DisposableStore();
    for (const name of ['configuration', 'configurationDefaults'] as const) {
      const users = extensions.filter(extension => extension[name] !== undefined).map(extension => ({
        description: { identifier: new ExtensionIdentifier(extension.id) } as IExtensionDescription,
        value: extension[name],
        collector: new ExtensionMessageCollector(extension.id, message => this.messages.push(message)),
      }));
      points.get(name)!.accept(users, this.store.add(new DisposableStore()), context);
    }
  }

  /** Disposes without a following `apply`. */
  release(): void {
    this.store.dispose();
  }
}

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));
const fixtureExtension: IFakeExtension = {
  id: 'writing-room-tests.configuration',
  configuration: fixture.contributes.configuration,
  configurationDefaults: fixture.contributes.configurationDefaults,
};

let disposables: DisposableStore;
let host: Host;
let service: ConfigurationService;
let core: IConfigurationNode;

function storeSettings(text: string): void {
  service.saveUserSettings(text);
}

beforeEach(() => {
  disposables = new DisposableStore();
  host = new Host();
  core = {
    id: 'test.core',
    properties: { 'editor.wordWrap': { type: 'string', enum: ['off', 'on'], default: 'off' } },
  };
  configurationRegistry.registerConfiguration(core);
  const storage = disposables.add(new InMemoryStorageService(new InMemoryStorageDatabase()));
  storage.storeImmediately(userSettingsKey, '{}', StorageScope.PROFILE, StorageTarget.USER);
  service = disposables.add(new ConfigurationService(configurationRegistry, storage));
});

afterEach(async () => {
  host.release();
  await flush();
  configurationRegistry.deregisterConfigurations([core]);
  disposables.dispose();
});

test('registers both points, the defaults after the settings', () => {
  const names = ExtensionsRegistry.getExtensionPoints().map(point => point.name);
  expect(names.indexOf('configuration')).toBeGreaterThanOrEqual(0);
  expect(names.indexOf('configurationDefaults')).toBeGreaterThan(names.indexOf('configuration'));
});

test('reads a contributed default, and falls back to it for a user value of the wrong type', () => {
  host.apply([fixtureExtension]);
  expect(service.getValue('fixtureMarkdown.preview.fontSize')).toBe(14);
  expect(service.getValue('fixtureMarkdown.preview.fontFamily')).toContain('system-ui');
  storeSettings('{"fixtureMarkdown.preview.fontSize": "huge", "fixtureMarkdown.validate.enabled": true}');
  expect(service.getValue('fixtureMarkdown.preview.fontSize')).toBe(14);
  expect(service.getValue('fixtureMarkdown.validate.enabled')).toBe(true);
  // The union type takes either member and nothing else.
  storeSettings('{"fixtureMarkdown.preview.lineNumbers": 3}');
  expect(service.getValue('fixtureMarkdown.preview.lineNumbers')).toBe(3);
  storeSettings('{"fixtureMarkdown.preview.lineNumbers": "3"}');
  expect(service.getValue('fixtureMarkdown.preview.lineNumbers')).toBe(false);
  expect(host.messages).toEqual([]);
});

test('registers every property of a manifest with 41 properties', () => {
  host.apply([fixtureExtension]);
  const registered = [...configurationRegistry.getConfigurationProperties().keys()].filter(key => key.startsWith('fixtureMarkdown.'));
  expect(Object.keys(fixture.contributes.configuration.properties)).toHaveLength(41);
  expect(registered.sort()).toEqual(Object.keys(fixture.contributes.configuration.properties).sort());
  expect(host.messages).toEqual([]);
});

test('keeps the first extension’s property and tells the second one both names', () => {
  const property = (description: string) => ({ properties: { 'shared.key': { type: 'string', default: description } } });
  host.apply([{ id: 'a.first', configuration: property('first') }, { id: 'b.second', configuration: property('second') }]);
  expect(service.getValue('shared.key')).toBe('first');
  expect(host.messages).toEqual([expect.objectContaining({
    extensionId: 'b.second', severity: 'warn', path: 'contributes.configuration.properties.shared.key',
    message: expect.stringMatching(/'a\.first'.*'b\.second'|'b\.second'.*'a\.first'/),
  })]);
  host.apply([{ id: 'a.first', configuration: property('first') }, { id: 'b.second', configuration: property('second') }]);
  host.apply([{ id: 'b.second', configuration: property('second') }]);
  expect(service.getValue('shared.key')).toBe('second');
});

test('names the core as the owner of a key an extension tries to take', () => {
  host.apply([{ id: 'a.first', configuration: { properties: { 'editor.wordWrap': { type: 'string' } } } }]);
  expect(host.messages).toEqual([expect.objectContaining({ extensionId: 'a.first', message: expect.stringContaining("'test.core'") })]);
});

test('registers the other properties when one is wrong, and says which one', () => {
  host.apply([{ id: 'a.first', configuration: [{ properties: {
    'good.one': { type: 'boolean', default: true },
    'bad.default': { type: 'number', default: 'zero' },
    'bad.type': { type: 'strange' },
    'bad.__proto__.part': { type: 'string' },
    '[markdown]': { type: 'string' },
    'good.two': { type: 'string', default: 'two' },
  } }, 'not a node', { title: 3 }] }]);
  expect(service.getValue('good.one')).toBe(true);
  expect(service.getValue('good.two')).toBe('two');
  const keys = configurationRegistry.getConfigurationProperties();
  expect(['bad.default', 'bad.type', 'bad.__proto__.part', '[markdown]'].filter(key => keys.has(key))).toEqual([]);
  expect(host.messages.map(message => [message.severity, message.path]).sort()).toEqual([
    ['error', 'contributes.configuration[1]'],
    ['error', 'contributes.configuration[2].title'],
    ['warn', 'contributes.configuration.properties.bad.__proto__.part'],
    ['warn', 'contributes.configuration.properties.bad.default'],
    ['warn', 'contributes.configuration.properties.bad.type'],
    ['warn', 'contributes.configuration[0].properties.[markdown]'],
  ].sort());
  expect(host.messages.find(message => message.path.endsWith('[markdown]'))!.message).toContain('configurationDefaults');
});

test('warns about a "__proto__" property from a parsed manifest instead of dropping it silently', () => {
  const configuration = JSON.parse('{"properties": {"__proto__": {"type": "string"}, "good.key": {"type": "string"}}}');
  host.apply([{ id: 'a.first', configuration }]);
  expect(service.getValue('good.key')).toBe('');
  expect(host.messages).toEqual([expect.objectContaining({
    extensionId: 'a.first', severity: 'warn', path: 'contributes.configuration.properties.__proto__',
  })]);
});

test('removes the keys and defaults after the registrations are released, without a following accept', async () => {
  host.apply([fixtureExtension]);
  expect(service.getValue('editor.wordWrap', { overrideIdentifier: 'markdown' })).toBe('on');
  host.release();
  expect(service.getValue('fixtureMarkdown.preview.fontSize')).toBe(14);
  await flush();
  expect(service.getValue('fixtureMarkdown.preview.fontSize')).toBeUndefined();
  expect(service.getValue('editor.wordWrap', { overrideIdentifier: 'markdown' })).toBe('off');
  expect(configurationRegistry.getLanguageDefaults().has('markdown')).toBe(false);
});

test('removes the keys when the extension goes away in the next accept, and keeps the user’s text', () => {
  host.apply([fixtureExtension]);
  const raw = '{"fixtureMarkdown.preview.fontSize": 20}';
  storeSettings(raw);
  expect(service.getValue('fixtureMarkdown.preview.fontSize')).toBe(20);
  host.apply([]);
  expect(service.getValue('fixtureMarkdown.preview.fontSize')).toBeUndefined();
  expect(service.getUserSettingsText()).toBe(raw);
  host.apply([fixtureExtension]);
  expect(service.getValue('fixtureMarkdown.preview.fontSize')).toBe(20);
});

test('gives no change event for a re-accept in the same turn, nor for another extension coming and going', async () => {
  host.apply([fixtureExtension]);
  storeSettings('{"fixtureMarkdown.preview.fontSize": 20}');
  const changes: string[][] = [];
  disposables.add(service.onDidChangeConfiguration(event => changes.push([...event.affectedKeys])));
  const touching = () => changes.flat().filter(key => key.startsWith('fixtureMarkdown') || key === 'editor.wordWrap');

  host.apply([fixtureExtension]);
  await flush();
  expect(service.getValue('fixtureMarkdown.preview.fontSize')).toBe(20);
  expect(touching()).toEqual([]);

  const other = { id: 'x.other', configuration: { properties: { 'other.key': { type: 'string', default: 'x' } } } };
  host.apply([other, fixtureExtension]);
  expect(service.getValue('other.key')).toBe('x');
  host.apply([fixtureExtension]);
  await flush();
  expect(service.getValue('other.key')).toBeUndefined();
  expect(touching()).toEqual([]);
  expect(changes.flat()).toEqual(expect.arrayContaining(['other.key']));
});

test('applies [markdown] and plain key defaults, reports a wrong one, and drops them on removal', () => {
  const defaults = { '[markdown]': { 'editor.wordWrap': 'on' }, 'editor.wordWrap': 'off', 'plain.key': 'changed' };
  host.apply([
    { id: 'a.first', configuration: { properties: { 'plain.key': { type: 'string', default: 'own' } } } },
    { id: 'b.second', configurationDefaults: { ...defaults, '[plaintext]': { 'editor.wordWrap': 'sideways' } } },
  ]);
  expect(service.getValue('editor.wordWrap', { overrideIdentifier: 'markdown' })).toBe('on');
  expect(service.getValue('editor.wordWrap')).toBe('off');
  expect(service.getValue('plain.key')).toBe('changed');
  expect(service.getValue('editor.wordWrap', { overrideIdentifier: 'plaintext' })).toBe('off');
  expect(host.messages).toEqual([expect.objectContaining({
    extensionId: 'b.second', severity: 'warn', path: expect.stringMatching(/^contributes\.configurationDefaults\./),
    message: expect.stringContaining('[plaintext]'),
  })]);
  host.apply([{ id: 'a.first', configuration: { properties: { 'plain.key': { type: 'string', default: 'own' } } } }]);
  expect(service.getValue('editor.wordWrap', { overrideIdentifier: 'markdown' })).toBe('off');
  expect(service.getValue('plain.key')).toBe('own');
});

test('reports a configurationDefaults value that is not an object through the host’s validation', () => {
  const validate = points.get('configurationDefaults')!.validate;
  expect(validate({})).toBe(true);
  expect(validate([])).toBe(false);
  expect(validate('x')).toBe(false);
  expect(points.get('configuration')!.validate([{}])).toBe(true);
  expect(points.get('configuration')!.validate(3)).toBe(false);
});
