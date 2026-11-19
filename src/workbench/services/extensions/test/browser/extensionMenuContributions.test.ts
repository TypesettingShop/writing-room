import { expect, test, vi } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
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

test('selects the current theme icon and refreshes menu entries when the theme changes', () => {
  const changed = new Emitter<IColorTheme>();
  let type: ColorScheme = ColorScheme.LIGHT;
  const themes: IThemeService = {
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
  const commands = [
    { command: 'test.activeTheme', title: 'Active theme', icon: { light: 'light.svg', dark: 'dark.svg' } },
  ];
  const extension = { ...description, manifest: { ...description.manifest, contributes: {
    commands, menus: { 'editor/context': [{ command: 'test.activeTheme' }] },
  } } };
  const service = new ExtensionService(() => ({ extensions: [extension], messages: [] }), undefined, undefined, themes);
  const assertIcon = (file: string) => {
    const icon = new URL(location + file);
    expect(MenuRegistry.getCommand('test.activeTheme')?.icon).toEqual(icon);
    expect(MenuRegistry.getMenuItems(MenuId.EditorContext)).toEqual([
      expect.objectContaining({ command: expect.objectContaining({ icon }) }),
    ]);
  };
  try {
    service.initialize();
    assertIcon('light.svg');
    type = ColorScheme.HIGH_CONTRAST_DARK;
    changed.fire(themes.getColorTheme());
    assertIcon('dark.svg');
    type = ColorScheme.HIGH_CONTRAST_LIGHT;
    changed.fire(themes.getColorTheme());
    assertIcon('light.svg');
  } finally {
    service.dispose();
    changed.dispose();
  }
});
