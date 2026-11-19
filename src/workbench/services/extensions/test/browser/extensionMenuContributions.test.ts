import { expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ExtensionService } from '../../browser/extensionService.js';
import { ExtensionsRegistry, ExtensionMessageCollector } from '../../common/extensionsRegistry.js';
import type { ExtensionPointContext } from '../../common/extensionsRegistry.js';

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

test('selects only the light icon on a light theme after both paths validate', () => {
  const icons: URL[] = [];
  const registrations = new DisposableStore();
  const context: ExtensionPointContext = {
    isLightTheme: true,
    viewHandler: { acceptContainers() {}, acceptViews() {} },
    setCommandOwner() {}, getCommandOwner: () => undefined, addActivationEvent() {},
  };
  const collector = new ExtensionMessageCollector(id, message => { throw new Error(message.message); });
  try {
    const point = ExtensionsRegistry.getExtensionPoints().find(point => point.name === 'commands')!;
    point.accept([{
      description, collector, value: [
        { command: 'test.light', title: 'Light', icon: { light: 'light.svg', dark: 'dark.svg' } },
      ],
      resolveIcon: url => (icons.push(url), url),
    }], registrations, context);
    expect(icons).toEqual([new URL(location + 'light.svg')]);
    expect(MenuRegistry.getCommand('test.light')?.icon).toEqual(icons[0]);
  } finally {
    registrations.dispose();
  }
});
