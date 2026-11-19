import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { MonacoNamespace } from '../../../../../editor/browser/monaco.js';
import { configurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../../platform/extensions/common/extensions.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ColorScheme } from '../../../../../platform/theme/common/themeService.js';
import type { IColorTheme } from '../../../../../platform/theme/common/themeService.js';
import { ConfigurationService } from '../../../configuration/browser/configurationService.js';
import { ExtensionMessageCollector, ExtensionsRegistry } from '../../../extensions/common/extensionsRegistry.js';
import type { ExtensionPointContext } from '../../../extensions/common/extensionsRegistry.js';
import {
  COLOR_THEME_SETTING, MONACO_THEME_NAME, monacoTokenRules, WorkbenchThemeService,
} from '../../browser/workbenchThemeService.js';
import { themeContributions } from '../../common/themeExtensionPoints.js';

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const point = ExtensionsRegistry.getExtensionPoints().find(candidate => candidate.name === 'themes')!;
const extensionsAt = 'http://127.0.0.1:9/';

/** Does what the extension service does with the `themes` point: each apply replaces the last. */
class Host {
  readonly messages: IExtensionMessage[] = [];
  private store = new DisposableStore();
  extensions: readonly { id: string; themes: unknown; version?: string }[] = [];

  apply(extensions = this.extensions): void {
    this.extensions = extensions;
    this.store.dispose();
    this.store = new DisposableStore();
    this.messages.length = 0;
    point.accept(extensions.map(extension => ({
      description: {
        identifier: new ExtensionIdentifier(extension.id),
        location: extensionsAt + extension.id + '/',
        manifest: { name: extension.id, displayName: extension.id + ' Themes', version: extension.version ?? '1.0.0' },
      } as unknown as IExtensionDescription,
      value: extension.themes,
      collector: new ExtensionMessageCollector(extension.id, message => this.messages.push(message)),
    })), this.store, {} as ExtensionPointContext);
  }

  release(): void {
    this.store.dispose();
  }
}

/** Files by URL; a file can be held back to answer later. */
class Files {
  readonly files = new Map<string, string>();
  readonly reads: string[] = [];
  readonly held = new Map<string, () => void>();
  hold = false;

  readonly service = {
    readFile: async (resource: URI) => {
      const url = resource.toString();
      this.reads.push(url);
      if (this.hold) {
        await new Promise<void>(resolve => this.held.set(url, resolve));
      }
      const text = this.files.get(url);
      if (text === undefined) {
        throw new Error('Not found: ' + url);
      }
      return { value: new TextEncoder().encode(text) };
    },
  } as unknown as IFileService;

  set(path: string, content: unknown): void {
    this.files.set(extensionsAt + path, typeof content === 'string' ? content : JSON.stringify(content));
  }
}

interface FakeMonaco {
  readonly calls: string[];
  readonly defined: Map<string, { base: string; inherit: boolean; colors: Record<string, string>; rules: unknown[] }>;
  readonly namespace: MonacoNamespace;
}

function fakeMonaco(): FakeMonaco {
  const calls: string[] = [];
  const defined = new Map();
  const namespace = {
    editor: {
      setTheme: (name: string) => calls.push('setTheme ' + name),
      defineTheme: (name: string, data: unknown) => {
        if (!/^[a-z0-9-]+$/i.test(name)) {
          throw new Error('Illegal theme name!');
        }
        calls.push('defineTheme ' + name);
        defined.set(name, data);
      },
    },
  } as unknown as MonacoNamespace;
  return { calls, defined, namespace };
}

class TestThemeService extends WorkbenchThemeService {
  // Set while the base constructor runs, so it must not be a field with an initializer.
  declare monacoListener: ((monaco: MonacoNamespace) => void) | undefined;
  protected override watchMonaco(listener: (monaco: MonacoNamespace) => void): IDisposable {
    this.monacoListener = listener;
    return { dispose: () => { this.monacoListener = undefined; } };
  }
}

let disposables: DisposableStore;
let storage: InMemoryStorageService;
let configuration: ConfigurationService;
let files: Files;
let host: Host;
let container: HTMLElement;
let warnings: string[];

function createService(settings = '{}'): { service: TestThemeService; events: IColorTheme[] } {
  storage.storeImmediately('user.settings.json', settings, StorageScope.PROFILE, StorageTarget.USER);
  configuration = disposables.add(new ConfigurationService(configurationRegistry, storage));
  const service = disposables.add(new TestThemeService(configuration, files.service, { mainContainer: container }));
  const events: IColorTheme[] = [];
  disposables.add(service.onDidColorThemeChange(theme => events.push(theme)));
  return { service, events };
}

const variable = (id: string) => container.style.getPropertyValue('--vscode-' + id.replace(/\./g, '-'));

beforeEach(() => {
  disposables = new DisposableStore();
  storage = new InMemoryStorageService();
  files = new Files();
  host = new Host();
  container = document.createElement('div');
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((message: string) => { warnings.push(String(message)); });
});

afterEach(async () => {
  disposables.dispose();
  host.release();
  // The slot clears itself a microtask after its registration goes.
  await flush();
  expect(themeContributions.current).toEqual([]);
  vi.restoreAllMocks();
});

const oceanTheme = {
  id: 'fixture', themes: [{ label: 'Ocean', uiTheme: 'vs-dark', path: './themes/ocean.json' }],
};

test('the default theme is v0.1.0\'s dark palette on the container, with its kind class', () => {
  const { service, events } = createService();
  const theme = service.getColorTheme();
  expect(theme.id).toBe('writing-room-dark');
  expect(theme.type).toBe(ColorScheme.DARK);
  expect(container.classList.contains('vs-dark')).toBe(true);
  expect(variable('editor.background')).toBe('#171b24');
  expect(variable('statusBar.background')).toBe('#20334e');
  expect(variable('list.hoverBackground')).toBe('#ffffff12');
  // A reference resolves through the same theme.
  expect(variable('tab.activeBackground')).toBe('#171b24');
  // A color without a default stays unset, so a stylesheet's fallback applies.
  expect(variable('selection.background')).toBe('');
  expect(events).toEqual([]);
});

test('the built-in light theme is light everywhere: type, kind class and colors', () => {
  const { service, events } = createService('{ "workbench.colorTheme": "Writing Room Light" }');
  expect(service.getColorTheme().type).toBe(ColorScheme.LIGHT);
  expect(service.getColorTheme().id).toBe('writing-room-light');
  expect(container.classList.contains('vs')).toBe(true);
  expect(container.classList.contains('vs-dark')).toBe(false);
  expect(variable('editor.background')).toBe('#fbfcfe');
  expect(events).toEqual([]);
});

test('changing the setting applies the theme once, CSS and Monaco before the event', async () => {
  const { service, events } = createService();
  const monaco = fakeMonaco();
  service.monacoListener!(monaco.namespace);
  expect(monaco.calls).toEqual(['setTheme vs-dark']);

  const seen: string[] = [];
  disposables.add(service.onDidColorThemeChange(() => seen.push(variable('editor.background') + ' ' + monaco.calls.at(-1))));
  await configuration.updateValue(COLOR_THEME_SETTING, 'Writing Room Light');
  expect(events.map(theme => theme.type)).toEqual([ColorScheme.LIGHT]);
  expect(seen).toEqual(['#fbfcfe setTheme ' + MONACO_THEME_NAME]);
  expect(monaco.defined.get(MONACO_THEME_NAME)).toMatchObject({ base: 'vs', inherit: true });
  expect(monaco.defined.get(MONACO_THEME_NAME)!.colors['editor.background']).toBe('#fbfcfe');

  // The default dark theme gives Monaco its own `vs-dark`, untouched.
  await configuration.updateValue(COLOR_THEME_SETTING, undefined);
  expect(events).toHaveLength(2);
  expect(monaco.calls.at(-1)).toBe('setTheme vs-dark');
});

test('a theme chosen before Monaco loads is given to it when it loads', async () => {
  const { service } = createService('{ "workbench.colorTheme": "Writing Room Light" }');
  const monaco = fakeMonaco();
  service.monacoListener!(monaco.namespace);
  expect(monaco.calls).toEqual(['defineTheme ' + MONACO_THEME_NAME, 'setTheme ' + MONACO_THEME_NAME]);
});

test('contributions applied again on every theme change fire no further change', async () => {
  host.apply([oceanTheme]);
  files.set('fixture/themes/ocean.json', { colors: { 'editor.background': '#003344' } });
  const { service, events } = createService();
  // What the extension service does: every theme change applies all contributions again.
  disposables.add(service.onDidColorThemeChange(() => host.apply()));
  await configuration.updateValue(COLOR_THEME_SETTING, 'Ocean');
  await flush();
  await configuration.updateValue(COLOR_THEME_SETTING, 'Writing Room Light');
  await flush();
  expect(events.map(theme => theme.label)).toEqual(['Ocean', 'Writing Room Light']);
  expect(files.reads).toHaveLength(1);
});

test('themes arriving or going that are not the chosen one change nothing', async () => {
  const { service, events } = createService();
  host.apply([oceanTheme]);
  await flush();
  host.apply([]);
  await flush();
  expect(events).toEqual([]);
  expect(service.getColorTheme().id).toBe('writing-room-dark');
  expect(files.reads).toEqual([]);
});

test('an extension theme applies its colors to the container and Monaco, and its token rules', async () => {
  host.apply([oceanTheme]);
  files.set('fixture/themes/ocean.json', `{
    // Comments are allowed.
    "colors": { "editor.background": "#003344", "sideBar.background": "#0A1", "myExtension.accent": "#ff0000" },
    "tokenColors": [
      { "settings": { "foreground": "#EEEEEE" } },
      { "scope": "comment", "settings": { "foreground": "#7f7f7f", "fontStyle": "italic" } },
      { "scope": "string.quoted, keyword", "settings": { "foreground": "#abc" } },
      { "scope": ["source.js meta.function"], "settings": { "foreground": "#123456" } },
    ],
  }`);
  const { service, events } = createService('{ "workbench.colorTheme": "Ocean" }');
  const monaco = fakeMonaco();
  service.monacoListener!(monaco.namespace);
  expect(service.getColorTheme().id).toBe('writing-room-dark');
  await flush();
  expect(events).toHaveLength(1);
  const theme = service.getColorTheme();
  expect(theme.label).toBe('Ocean');
  expect(theme.type).toBe(ColorScheme.DARK);
  expect(theme.defines('editor.background')).toBe(true);
  expect(theme.defines('panel.background')).toBe(false);
  expect(variable('editor.background')).toBe('#003344');
  expect(variable('sideBar.background')).toBe('#00aa11');
  // An id nothing registered is published too; a color the theme leaves out has its dark default.
  expect(variable('myExtension.accent')).toBe('#ff0000');
  expect(variable('panel.background')).toBe('#181d27');
  expect(variable('tab.activeBackground')).toBe('#003344');
  expect(monaco.defined.get(MONACO_THEME_NAME)).toEqual({
    base: 'vs-dark', inherit: true,
    colors: { 'editor.background': '#003344', 'sideBar.background': '#00aa11', 'myExtension.accent': '#ff0000' },
    rules: [
      { token: '', foreground: 'eeeeee' },
      { token: 'comment', foreground: '7f7f7f', fontStyle: 'italic' },
      { token: 'string.quoted', foreground: 'aabbcc' },
      { token: 'keyword', foreground: 'aabbcc' },
    ],
  });
  expect(theme.tokenColors[2]).toEqual({ scope: 'string.quoted, keyword', settings: { foreground: '#aabbcc' } });
});

test('values that are not hex colors, and ids that are not color ids, never reach a variable', async () => {
  host.apply([oceanTheme]);
  files.set('fixture/themes/ocean.json', {
    colors: {
      'editor.background': 'red; } body { display: none',
      'statusBar.background': 'url(https://example.test/x.png)',
      'panel.background': 'rgb(1, 2, 3)',
      'sideBar.background': '#123456',
      'evil; } body { x': '#ffffff',
      'menu.background': 42,
    },
    tokenColors: [{ scope: 'comment', settings: { foreground: 'red; }', fontStyle: 'bold; x' } }, 'nonsense'],
  });
  const { service } = createService('{ "workbench.colorTheme": "Ocean" }');
  await flush();
  expect(service.getColorTheme().label).toBe('Ocean');
  expect(variable('sideBar.background')).toBe('#123456');
  expect(variable('editor.background')).toBe('#171b24');
  expect(variable('statusBar.background')).toBe('#20334e');
  expect(variable('panel.background')).toBe('#181d27');
  expect(variable('menu.background')).toBe('#232c3d');
  expect(container.getAttribute('style')).not.toMatch(/url\(|rgb\(|display|evil|red;/);
  expect(service.getColorTheme().tokenColors).toEqual([]);
  expect(warnings.join('\n')).toContain('the value of \'editor.background\' is not a hex color');
  expect(warnings.join('\n')).toContain('\'evil; } body { x\' is not a color id');
});

test('a theme path or include that leaves the extension is never read; a cycle of includes stops', async () => {
  host.apply([{
    id: 'fixture', themes: [
      { label: 'Outside', uiTheme: 'vs-dark', path: '../other/theme.json' },
      { label: 'Absolute', uiTheme: 'vs-dark', path: 'http://127.0.0.1:9/other/theme.json' },
      { label: 'Plist', uiTheme: 'vs-dark', path: './themes/old.tmTheme' },
      { label: 'Escaping Include', uiTheme: 'vs', path: './themes/escape.json' },
      { label: 'Cycle', uiTheme: 'vs-dark', path: './themes/cycle.json' },
    ],
  }]);
  expect(host.messages.map(message => message.path)).toEqual([
    'contributes.themes[0].path', 'contributes.themes[1].path', 'contributes.themes[2].path',
  ]);
  files.set('other/theme.json', { colors: { 'editor.background': '#666666' } });
  files.set('fixture/themes/escape.json', { include: '../../other/theme.json', colors: { 'sideBar.background': '#101010' } });
  files.set('fixture/themes/cycle.json', { include: './cycle.json', colors: { 'sideBar.background': '#202020' } });
  const { service } = createService();
  expect(service.getColorThemes().map(theme => theme.label)).toEqual(['Writing Room Dark', 'Writing Room Light', 'Escaping Include', 'Cycle']);

  await configuration.updateValue(COLOR_THEME_SETTING, 'Escaping Include');
  await flush();
  expect(service.getColorTheme().label).toBe('Escaping Include');
  expect(variable('sideBar.background')).toBe('#101010');
  expect(files.reads).toEqual([extensionsAt + 'fixture/themes/escape.json']);

  await configuration.updateValue(COLOR_THEME_SETTING, 'Cycle');
  await flush();
  expect(service.getColorTheme().label).toBe('Cycle');
  expect(variable('sideBar.background')).toBe('#202020');
  // The file and five includes of it, then the depth limit.
  expect(files.reads.filter(url => url.endsWith('/cycle.json'))).toHaveLength(6);
  expect(files.reads.some(url => url.includes('/other/'))).toBe(false);
  expect(warnings.join('\n')).toContain('includes go at most 5 files deep');
});

test('includes come first and the including file wins; token files and semantic colors are refused with a warning', async () => {
  host.apply([oceanTheme]);
  files.set('fixture/themes/base/common.json', {
    colors: { 'editor.background': '#111111', 'panel.background': '#222222' },
    tokenColors: [{ scope: 'comment', settings: { foreground: '#333333' } }],
  });
  files.set('fixture/themes/ocean.json', {
    include: './base/common.json',
    colors: { 'editor.background': '#444444', 'panel.background': 'default' },
    tokenColors: [{ scope: 'string', settings: { foreground: '#555555' } }],
    semanticHighlighting: true,
    semanticTokenColors: { variable: '#ffffff' },
  });
  const { service } = createService('{ "workbench.colorTheme": "Ocean" }');
  await flush();
  const theme = service.getColorTheme();
  expect(variable('editor.background')).toBe('#444444');
  expect(variable('panel.background')).toBe('#181d27');
  expect(theme.tokenColors.map(rule => rule.scope)).toEqual(['comment', 'string']);
  expect(theme.semanticHighlighting).toBe(true);
  expect(warnings.join('\n')).toContain('semantic token colors are not supported');
});

test('removing the chosen theme\'s extension falls back without touching the setting; reinstalling brings it back', async () => {
  host.apply([oceanTheme]);
  files.set('fixture/themes/ocean.json', { colors: { 'editor.background': '#003344' } });
  const text = '{\n  // mine\n  "workbench.colorTheme": "Ocean"\n}\n';
  const { service, events } = createService(text);
  await flush();
  expect(service.getColorTheme().label).toBe('Ocean');

  host.apply([]);
  await flush();
  expect(service.getColorTheme().id).toBe('writing-room-dark');
  expect(variable('editor.background')).toBe('#171b24');
  expect(configuration.getUserSettingsText()).toBe(text);
  expect(service.getConfiguredThemeId()).toBe('Ocean');

  host.apply([oceanTheme]);
  await flush();
  expect(service.getColorTheme().label).toBe('Ocean');
  expect(variable('editor.background')).toBe('#003344');
  expect(events.map(theme => theme.label)).toEqual(['Ocean', 'Writing Room Dark', 'Ocean']);
  // The file is read again for the new contribution.
  expect(files.reads).toHaveLength(2);
});

test('a new version of the extension at the same place reads the theme file again', async () => {
  host.apply([oceanTheme]);
  files.set('fixture/themes/ocean.json', { colors: { 'editor.background': '#003344' } });
  const { service } = createService('{ "workbench.colorTheme": "Ocean" }');
  await flush();
  expect(variable('editor.background')).toBe('#003344');
  files.set('fixture/themes/ocean.json', { colors: { 'editor.background': '#004455' } });
  host.apply([{ ...oceanTheme, version: '2.0.0' }]);
  await flush();
  expect(variable('editor.background')).toBe('#004455');
  expect(service.getColorTheme().label).toBe('Ocean');
  expect(files.reads).toHaveLength(2);
});

test('while the chosen theme is missing, the applied theme is the default one', () => {
  const { service } = createService('{ "workbench.colorTheme": "Ocean" }');
  expect(service.getConfiguredThemeId()).toBe('Ocean');
  expect(service.getAppliedThemeId()).toBe('Writing Room Dark');
});

test('a theme file that arrives after another theme was chosen is dropped, even when it read fine', async () => {
  host.apply([oceanTheme]);
  files.set('fixture/themes/ocean.json', { colors: { 'editor.background': '#003344' } });
  files.hold = true;
  const { service, events } = createService();
  await configuration.updateValue(COLOR_THEME_SETTING, 'Ocean');
  await flush();
  expect(files.held.size).toBe(1);
  await configuration.updateValue(COLOR_THEME_SETTING, 'Writing Room Light');
  expect(service.getColorTheme().type).toBe(ColorScheme.LIGHT);

  files.held.get(extensionsAt + 'fixture/themes/ocean.json')!();
  await flush();
  expect(service.getColorTheme().type).toBe(ColorScheme.LIGHT);
  expect(variable('editor.background')).toBe('#fbfcfe');
  expect(events.map(theme => theme.label)).toEqual(['Writing Room Light']);

  // The file read stays: choosing the theme again applies it at once.
  await configuration.updateValue(COLOR_THEME_SETTING, 'Ocean');
  await flush();
  expect(service.getColorTheme().label).toBe('Ocean');
  expect(files.reads).toHaveLength(1);
});

test('a preview shows a theme without writing the setting, and ending it goes back', async () => {
  const { service, events } = createService();
  const text = configuration.getUserSettingsText();
  service.previewColorTheme('Writing Room Light');
  expect(service.getColorTheme().type).toBe(ColorScheme.LIGHT);
  expect(configuration.getUserSettingsText()).toBe(text);
  service.previewColorTheme(undefined);
  expect(service.getColorTheme().type).toBe(ColorScheme.DARK);
  expect(events.map(theme => theme.type)).toEqual([ColorScheme.LIGHT, ColorScheme.DARK]);
});

test('Monaco gets only simple scopes, six hex digits and no rule for a scoped entry with an empty scope', () => {
  expect(monacoTokenRules([
    { scope: '', settings: { foreground: '#112233' } },
    { scope: 'a.b-c', settings: { foreground: '#11223344', background: '#556677' } },
    { scope: 'a b', settings: { foreground: '#112233' } },
    { scope: ['x', 'y > z'], settings: { fontStyle: '' } },
  ])).toEqual([
    { token: 'a.b-c', foreground: '112233', background: '556677' },
    { token: 'x', fontStyle: '' },
  ]);
});
