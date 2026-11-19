import { afterEach, beforeEach, expect, test } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { MonacoNamespace } from '../../../../../editor/browser/monaco.js';
import { configurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../../platform/extensions/common/extensions.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { colorRegistry } from '../../../../../platform/theme/common/colorRegistry.js';
import { ConfigurationService } from '../../../configuration/browser/configurationService.js';
import { ExtensionMessageCollector, ExtensionsRegistry } from '../../../extensions/common/extensionsRegistry.js';
import type { ExtensionPointContext } from '../../../extensions/common/extensionsRegistry.js';
import { COLOR_THEME_SETTING, WorkbenchThemeService } from '../../browser/workbenchThemeService.js';
import '../../common/colorExtensionPoint.js';

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const point = ExtensionsRegistry.getExtensionPoints().find(candidate => candidate.name === 'colors')!;

class Host {
  readonly messages: IExtensionMessage[] = [];
  private store = new DisposableStore();
  extensions: readonly { id: string; colors: unknown }[] = [];

  apply(extensions = this.extensions): void {
    this.extensions = extensions;
    this.store.dispose();
    this.store = new DisposableStore();
    this.messages.length = 0;
    point.accept(extensions.map(extension => ({
      description: { identifier: new ExtensionIdentifier(extension.id) } as IExtensionDescription,
      value: extension.colors,
      collector: new ExtensionMessageCollector(extension.id, message => this.messages.push(message)),
    })), this.store, {} as ExtensionPointContext);
  }

  release(): void {
    this.store.dispose();
  }
}

class TestThemeService extends WorkbenchThemeService {
  protected override watchMonaco(_listener: (monaco: MonacoNamespace) => void): IDisposable {
    return { dispose: () => {} };
  }
}

let disposables: DisposableStore;
let host: Host;
let container: HTMLElement;
let configuration: ConfigurationService;
let service: TestThemeService;
let schemaChanges: number;

beforeEach(() => {
  disposables = new DisposableStore();
  host = new Host();
  container = document.createElement('div');
  configuration = disposables.add(new ConfigurationService(configurationRegistry, new InMemoryStorageService()));
  service = disposables.add(new TestThemeService(configuration, {} as IFileService, { mainContainer: container }));
  schemaChanges = 0;
  disposables.add(colorRegistry.onDidChangeSchema(() => schemaChanges++));
});

afterEach(async () => {
  host.release();
  await flush();
  disposables.dispose();
  expect(colorRegistry.getColors().filter(color => color.extensionId)).toEqual([]);
});

const variable = (id: string) => container.style.getPropertyValue('--vscode-' + id.replace(/\./g, '-'));

const fixtureColors = [
  { id: 'fixture.accent', description: 'Accent', defaults: { dark: '#112233', light: '#ddeeff', highContrast: '#000000' } },
  { id: 'fixture.follow', description: 'Follows the editor', defaults: { dark: 'editor.background', light: 'fixture.accent' } },
];

test('a contributed color is a CSS variable with the default of the theme\'s kind, following references', async () => {
  host.apply([{ id: 'test.colors', colors: fixtureColors }]);
  expect(host.messages).toEqual([]);
  expect(colorRegistry.getColor('fixture.accent')?.extensionId).toBe('test.colors');
  expect(variable('fixture.accent')).toBe('#112233');
  expect(variable('fixture.follow')).toBe('#171b24');
  await configuration.updateValue(COLOR_THEME_SETTING, 'Writing Room Light');
  expect(variable('fixture.accent')).toBe('#ddeeff');
  expect(variable('fixture.follow')).toBe('#ddeeff');
  // `highContrastLight` falls back to `light`, `highContrast` was given.
  expect(colorRegistry.getColor('fixture.accent')!.defaults).toEqual({ dark: '#112233', light: '#ddeeff', hcDark: '#000000', hcLight: '#ddeeff' });
});

test('a wrong id or default is refused with a message, and the other colors stay', () => {
  host.apply([{ id: 'test.colors', colors: [
    { id: 'bad-id', description: 'x', defaults: { dark: '#000000', light: '#ffffff' } },
    { id: '.dot', description: 'x', defaults: { dark: '#000000', light: '#ffffff' } },
    { id: 'fixture.css', description: 'x', defaults: { dark: 'red; } body { display: none', light: '#ffffff' } },
    { id: 'fixture.url', description: 'x', defaults: { dark: '#000000', light: 'url(https://example.test/x)' } },
    { id: 'fixture.named', description: 'x', defaults: { dark: 'red', light: '#ffffff' } },
    { id: 'fixture.nolight', description: 'x', defaults: { dark: '#000000' } },
    { id: 'fixture.nodescription', defaults: { dark: '#000000', light: '#ffffff' } },
    { id: 'fixture.hc', description: 'x', defaults: { dark: '#000000', light: '#ffffff', highContrast: 'rgb(0,0,0)' } },
    { id: 'editor.background', description: 'x', defaults: { dark: '#000000', light: '#ffffff' } },
    ...fixtureColors,
  ] }]);
  expect(host.messages.map(message => message.path)).toEqual([
    'contributes.colors[0].id', 'contributes.colors[1].id', 'contributes.colors[2].defaults.dark',
    'contributes.colors[3].defaults.light', 'contributes.colors[5].defaults',
    'contributes.colors[6].description', 'contributes.colors[7].defaults.highContrast', 'contributes.colors[8].id',
  ]);
  expect(host.messages.every(message => message.severity === 'error')).toBe(true);
  // As in VS Code, a default that is not a hex color names another color: `red` is a color id, of no color.
  expect(colorRegistry.getColors().filter(color => color.extensionId).map(color => color.id))
    .toEqual(['fixture.named', 'fixture.accent', 'fixture.follow']);
  expect(variable('fixture.named')).toBe('');
  expect(variable('editor.background')).toBe('#171b24');
  expect(container.getAttribute('style')).not.toMatch(/url\(|display|bad-id/);
});

test('the same id from a second extension is refused while the first one has it', () => {
  host.apply([{ id: 'test.first', colors: fixtureColors }, { id: 'test.second', colors: [fixtureColors[0]] }]);
  expect(host.messages).toEqual([expect.objectContaining({ extensionId: 'test.second', path: 'contributes.colors[0].id' })]);
  expect(colorRegistry.getColor('fixture.accent')?.extensionId).toBe('test.first');
  host.apply([{ id: 'test.second', colors: [fixtureColors[0]] }]);
  expect(host.messages).toEqual([]);
  expect(colorRegistry.getColor('fixture.accent')?.extensionId).toBe('test.second');
});

test('applying the same colors again changes nothing; removing the extension removes them', async () => {
  host.apply([{ id: 'test.colors', colors: fixtureColors }]);
  expect(schemaChanges).toBe(1);
  // The extension service releases and applies every contribution again on each theme change.
  host.apply();
  await flush();
  expect(schemaChanges).toBe(1);
  expect(variable('fixture.accent')).toBe('#112233');

  host.apply([]);
  await flush();
  expect(schemaChanges).toBe(2);
  expect(colorRegistry.getColor('fixture.accent')).toBeUndefined();
  expect(variable('fixture.accent')).toBe('');
});
