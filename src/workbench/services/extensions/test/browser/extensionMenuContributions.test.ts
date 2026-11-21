import { expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { configurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { registerExtensionViewBody, ViewsExtensionHandler } from '../../../../api/browser/viewsExtensionPoint.js';
import { viewContainersRegistry, viewsRegistry } from '../../../../common/views.js';
import { ConfigurationService } from '../../../configuration/browser/configurationService.js';
import { COLOR_THEME_SETTING, WorkbenchThemeService } from '../../../themes/browser/workbenchThemeService.js';
import '../../../../api/common/configurationExtensionPoint.js';
import '../../../themes/common/colorExtensionPoint.js';
import { ExtensionMessageCollector, ExtensionsRegistry } from '../../common/extensionsRegistry.js';
import { ExtensionService } from '../../browser/extensionService.js';
import { ColorScheme } from '../../../../../platform/theme/common/themeService.js';
import type { IColorTheme, IThemeService } from '../../../../../platform/theme/common/themeService.js';

const id = 'writer.test';
const location = 'https://example.test/extension/';
const description = {
  isBuiltin: true, location, identifier: new ExtensionIdentifier(id),
  manifest: { name: 'test', publisher: 'writer', version: '1.0.0' },
};

test('registers materialized submenus, individual menu placements and single-object keybindings', () => {
  const report = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const extension = { ...description, manifest: { ...description.manifest, contributes: {
    commands: [
      { command: 'test.preview', title: 'Preview', icon: { light: 'icon-light.svg', dark: 'icon-dark.svg' } },
      { command: 'test.missing', title: 'Missing icon', icon: { light: '../outside.svg', dark: '/outside.svg' } },
    ],
    submenus: [{ id: 'test.previewMode', label: 'Preview Mode', icon: '$(beaker)' }],
    menus: {
      'unknown/menu': [{ command: 'test.preview' }],
      'editor/context': [{ submenu: 'test.previewMode' }],
      'explorer/context': [{ command: 'test.preview', alt: 'test.missing' }],
      'webview/context': [{ command: 'test.missing' }],
      'test.previewMode': [{ command: 'test.preview', group: 'navigation@3' }],
    },
    keybindings: { command: 'test.preview', key: 'F12' },
  } } };
  const service = new ExtensionService(() => ({ extensions: [extension], messages: [] }));
  try {
    service.initialize();
    expect(MenuRegistry.getCommand('test.preview')?.icon).toEqual(new URL(location + 'icon-dark.svg'));
    expect(MenuRegistry.getCommand('test.missing')).toMatchObject({ title: 'Missing icon', icon: undefined });
    const submenu = MenuId.for('extension.submenu.test.previewMode');
    expect(MenuRegistry.getMenuItems(MenuId.EditorContext)).toEqual([expect.objectContaining({ submenu, title: 'Preview Mode' })]);
    expect(MenuRegistry.getMenuItems(submenu)).toEqual([
      expect.objectContaining({ command: expect.objectContaining({ id: 'test.preview' }), group: 'navigation', order: 3 }),
    ]);
    expect(MenuRegistry.getMenuItems(MenuId.ExplorerContext)).toEqual([
      expect.objectContaining({ command: expect.objectContaining({ id: 'test.preview' }) }),
    ]);
    expect(MenuRegistry.getMenuItems(MenuId.WebviewContext)).toEqual([
      expect.objectContaining({ command: expect.objectContaining({ id: 'test.missing' }) }),
    ]);
    expect(MenuRegistry.getMenuItems(MenuId.CommandPalette)).toContainEqual(expect.objectContaining({
      command: expect.objectContaining({ id: 'test.preview' }),
    }));
    expect(KeybindingsRegistry.getDefaultKeybindings()).toContainEqual(expect.objectContaining({ id: 'test.preview', key: 'F12' }));
    expect(service.getExtensionsStatus()[id].messages.map(({ path }) => path)).toContain('contributes.commands.1.icon.dark');
    expect(service.getExtensionsStatus()[id].messages.map(({ path }) => path)).toContain('contributes.commands.1.icon.light');
  } finally {
    service.dispose();
    report.mockRestore();
  }
});

const themedCommand = { ...description, manifest: { ...description.manifest, contributes: {
  commands: [{ command: 'test.activeTheme', title: 'Active theme', icon: { light: 'light.svg', dark: 'dark.svg' } }],
  menus: { 'editor/context': [{ command: 'test.activeTheme' }] },
} } };

function assertIcon(file: string): void {
  const icon = new URL(location + file);
  expect(MenuRegistry.getCommand('test.activeTheme')?.icon).toEqual(icon);
  expect(MenuRegistry.getMenuItems(MenuId.EditorContext)).toEqual([
    expect.objectContaining({ command: expect.objectContaining({ icon }) }),
  ]);
}

function fakeThemes(type: ColorScheme, disposables: DisposableStore) {
  const changed = disposables.add(new Emitter<IColorTheme>());
  const service: IThemeService = {
    _serviceBrand: undefined,
    onDidColorThemeChange: changed.event,
    getColorTheme: () => ({
      id: type, label: type, type,
      getColor: () => undefined,
      defines: () => false,
      tokenColors: [],
      semanticHighlighting: false,
    }),
  };
  return {
    service,
    setTheme(next: ColorScheme) {
      type = next;
      changed.fire(service.getColorTheme());
    },
  };
}

test('selects the current theme icon and refreshes menu entries when the theme changes', () => {
  const disposables = new DisposableStore();
  const themes = fakeThemes(ColorScheme.LIGHT, disposables);
  const service = disposables.add(new ExtensionService(
    () => ({ extensions: [themedCommand], messages: [] }), undefined, undefined, themes.service,
  ));
  try {
    service.initialize();
    assertIcon('light.svg');
    themes.setTheme(ColorScheme.HIGH_CONTRAST_DARK);
    assertIcon('dark.svg');
    themes.setTheme(ColorScheme.HIGH_CONTRAST_LIGHT);
    assertIcon('light.svg');
  } finally {
    disposables.dispose();
  }
});

function registerTestPoint(disposables: DisposableStore, accept: () => void) {
  return disposables.add(ExtensionsRegistry.registerExtensionPoint({
    name: 'testThemeReapplication', validate: (_value): _value is unknown => true, accept,
  }));
}

test.each([
  [ColorScheme.LIGHT, ColorScheme.DARK, 'dark.svg'],
  [ColorScheme.DARK, ColorScheme.LIGHT, 'light.svg'],
] as const)('reapplies contributions once when the theme changes during application (%s → %s)', (before, after, icon) => {
  const disposables = new DisposableStore();
  const themes = fakeThemes(before, disposables);
  const accept = vi.fn(() => {
    if (themes.service.getColorTheme().type === before) {
      themes.setTheme(after);
    }
  });
  registerTestPoint(disposables, accept);
  const service = disposables.add(new ExtensionService(
    () => ({ extensions: [themedCommand], messages: [] }), undefined, undefined, themes.service,
  ));
  const changed = vi.fn();
  disposables.add(service.onDidChangeExtensions(changed));
  try {
    service.initialize();
    assertIcon(icon);
    expect(accept).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
    accept.mockClear();
    themes.setTheme(after);
    expect(accept).toHaveBeenCalledTimes(1);
  } finally {
    service.dispose();
    disposables.dispose();
  }
});

test('bounds repeated changes and discards a failed pass before rolling back an extension', () => {
  const disposables = new DisposableStore();
  const themes = fakeThemes(ColorScheme.LIGHT, disposables);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const accept = vi.fn(() => {
    themes.setTheme(themes.service.getColorTheme().type === ColorScheme.LIGHT ? ColorScheme.DARK : ColorScheme.LIGHT);
  });
  registerTestPoint(disposables, accept);
  const service = disposables.add(new ExtensionService(
    () => ({ extensions: [themedCommand], messages: [] }), undefined, undefined, themes.service,
  ));
  const added = { ...description, identifier: new ExtensionIdentifier('writer.added') };
  try {
    service.initialize();
    expect(accept).toHaveBeenCalledTimes(4);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('contribution refresh'));
    accept.mockReset().mockImplementation(() => {});
    accept.mockImplementationOnce(() => themes.setTheme(ColorScheme.DARK));
    accept.mockImplementationOnce(() => {
      themes.setTheme(ColorScheme.LIGHT);
      throw new Error('test point failed');
    });
    expect(() => service.addExtension(added)).toThrow('test point failed');
    expect(service.extensions).toEqual([themedCommand]);
    expect(accept).toHaveBeenCalledTimes(3);
    assertIcon('light.svg');
    accept.mockClear();
    themes.setTheme(ColorScheme.DARK);
    expect(accept).toHaveBeenCalledTimes(1);
  } finally {
    service.dispose();
    disposables.dispose();
    warning.mockRestore();
  }
});

test('removing the selected light theme updates the remaining command and menu to dark icons', async () => {
  const disposables = new DisposableStore();
  const themedExtension = {
    ...description, identifier: new ExtensionIdentifier('writer.light-theme'),
    manifest: { ...description.manifest, contributes: {
      themes: [{ label: 'Fixture Light', uiTheme: 'vs', path: './theme.json' }],
    } },
  };
  const remaining = { ...themedCommand, manifest: { ...themedCommand.manifest, contributes: {
    ...themedCommand.manifest.contributes,
    themes: [{ label: 'Fixture Dark', uiTheme: 'vs-dark', path: './dark-theme.json' }],
    colors: [{ id: 'fixture.accent', description: 'Accent', defaults: { light: '#123456', dark: '#654321' } }],
    configurationDefaults: { [COLOR_THEME_SETTING]: 'Writing Room Dark' },
  } } };
  const configuration = disposables.add(new ConfigurationService(configurationRegistry, new InMemoryStorageService()));
  const files = { readFile: async () => ({ value: new TextEncoder().encode('{}') }) } as unknown as IFileService;
  const themes = disposables.add(new WorkbenchThemeService(configuration, files, {
    mainContainer: document.createElement('div'),
  }));
  const accept = vi.fn();
  registerTestPoint(disposables, accept);
  const service = disposables.add(new ExtensionService(
    () => ({ extensions: [themedExtension, remaining], messages: [] }), undefined, undefined, themes,
  ));
  try {
    service.initialize();
    const applied = new Promise<void>(resolve => disposables.add(themes.onDidColorThemeChange(() => resolve())));
    await configuration.updateValue(COLOR_THEME_SETTING, 'Fixture Light');
    await applied;
    expect(themes.getColorTheme().type).toBe(ColorScheme.LIGHT);
    assertIcon('light.svg');
    accept.mockClear();
    const changed = vi.fn();
    disposables.add(service.onDidChangeExtensions(changed));

    expect(service.removeExtension(themedExtension.identifier.value)).toBe(true);
    expect(themes.getColorTheme().type).toBe(ColorScheme.DARK);
    assertIcon('dark.svg');
    expect(accept).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    service.dispose();
    disposables.dispose();
  }
});

test('updates a view descriptor when its source, title or condition changes', () => {
  const handler = new ViewsExtensionHandler(() => undefined);
  const render = vi.fn(() => undefined);
  const renderer = registerExtensionViewBody('testView', render);
  const collector = new ExtensionMessageCollector(id, message => { throw new Error(message.message); });
  const changedDescription = { ...description, manifest: { ...description.manifest, version: '2.0.0' } };
  const acceptView = (source: typeof description, name: string, when: string) =>
    handler.acceptViews([{
      description: source, collector, value: { testContainer: [{ id: 'test.view', name, when, type: 'testView' }] },
    }], () => {});
  try {
    handler.acceptContainers([{
      description, collector, value: { activitybar: [{ id: 'testContainer', title: 'Fixture', icon: '$(beaker)' }] },
    }]);
    const container = viewContainersRegistry.get('workbench.view.extension.testContainer')!;
    const view = () => viewsRegistry.getViews(container).find(view => view.id === 'test.view')!;
    acceptView(description, 'First title', 'firstCondition');
    const first = view();
    acceptView(description, 'First title', 'firstCondition');
    expect(view()).toBe(first);
    acceptView(description, 'New title', 'firstCondition');
    expect(view().name).toBe('New title');
    acceptView(description, 'New title', 'secondCondition');
    expect(view().when?.serialize()).toBe('secondCondition');
    acceptView(changedDescription, 'New title', 'secondCondition');
    view().renderBody(document.createElement('div'));
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ extension: changedDescription }));
  } finally {
    handler.dispose();
    renderer.dispose();
  }
});
