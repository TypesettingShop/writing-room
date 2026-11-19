import { afterEach, expect, test, vi } from 'vitest';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription, IExtensionManifest } from '../../../../../platform/extensions/common/extensions.js';
import { validateExtensionManifest } from '../../../../../platform/extensions/common/extensionValidator.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import '../../../../browser/parts/views/defaultViews.contribution.js';
import { viewContainersRegistry, viewsRegistry } from '../../../../common/views.js';
import { ExtensionService } from '../../browser/extensionService.js';
import { resolveExtensionPath } from '../../common/extensionResources.js';

const origin = 'https://example.com/extensions/example/';
function description(name: string, contributes: unknown, isBuiltin = false): IExtensionDescription {
  const { manifest } = validateExtensionManifest({ name, publisher: 'Example', version: '1.0.0', contributes }, resolve);
  return { manifest: manifest!, identifier: ExtensionIdentifier.fromManifest(manifest!), isBuiltin, location: origin };
}
const resolve = (path: string) => resolveExtensionPath(origin, path);
let service: ExtensionService | undefined;
afterEach(() => {
  service?.dispose();
  service = undefined;
  vi.restoreAllMocks();
});

test.each(['../x', '/x', 'https://example.com/x.js', '..\\x', '%2e%2e/x', 'one/%2e%2e/%2fsecret', '%252e%252e/x'])(
  'rejects an unsafe extension resource %s',
  path => expect(resolve(path)).toBeUndefined(),
);

test('validates required metadata and resolves internal relative paths', () => {
  const valid: IExtensionManifest = { publisher: 'Example', name: 'sample', version: '1.0.0' };
  for (const key of Object.keys(valid)) {
    const input: Record<string, unknown> = { ...valid };
    delete input[key as keyof IExtensionManifest];
    expect(validateExtensionManifest(input, resolve).manifest).toBeUndefined();
  }
  for (const key of ['browser', 'icon']) {
    expect(validateExtensionManifest({ ...valid, [key]: '../x' }, resolve).manifest).toBeUndefined();
  }
  expect(resolve('./directory/../file%20name.js')?.href).toBe(origin + 'file%20name.js');
});

test('registers valid entries, diagnoses individual failures and cleans up dynamic contributions', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const builtin = description('Example', {
    commands: [null, { command: 'test.ext.command', title: 'Builtin' }, { command: 'test.bad', title: 'bad', icon: '/outside' }],
    menus: {
      'view/title': [
        { command: 'test.undeclared' },
        { command: 'test.ext.command', when: 'foo =~ /(/' },
        { command: 'test.ext.command', group: 'navigation@2' },
      ],
      bad: [{ command: 'test.ext.command' }],
    },
    keybindings: [
      { command: 'test.ext.command', key: 'bad' },
      { command: 'test.ext.command', key: 'F8', when: 'foo =~ /(/' },
      { command: 'test.ext.command', key: 'F8', mac: 'F9' },
    ],
    viewsContainers: { activitybar: [{ id: 'ext-test', title: 'Test', icon: '$(beaker)' }] },
    views: { 'ext-test': [{ id: 'ext-test.primary', name: 'Primary' }], missing: [{ id: 'ext-test.fallback', name: 'Fallback' }] },
    configuration: {},
  }, true);
  const duplicate = description('example', { commands: [{ command: 'test.ext.duplicate', title: 'Duplicate' }] });
  const installed = description('installed', {
    commands: [{ command: 'test.ext.command', title: 'Installed' }],
    keybindings: [{ command: 'test.ext.command', key: 'F12' }],
    views: { 'ext-test': [{ id: 'ext-test.installed', name: 'Installed' }] },
  });
  service = new ExtensionService(() => ({ extensions: [duplicate, builtin], messages: [] }));
  service.initialize();
  expect(await service.whenInstalledExtensionsRegistered()).toBe(true);
  expect(service.extensions).toEqual([builtin]);
  expect(MenuRegistry.getCommand('test.ext.duplicate')).toBeUndefined();
  expect(MenuRegistry.getCommand('test.bad')).toBeUndefined();
  expect(MenuRegistry.getMenuItems(MenuId.ViewTitle).filter(item => 'command' in item && item.command.id === 'test.ext.command'))
    .toEqual([expect.objectContaining({ group: 'navigation', order: 2 })]);
  const rules = () => KeybindingsRegistry.getDefaultKeybindings().filter(rule => rule.id === 'test.ext.command');
  expect(rules()).toEqual([expect.objectContaining({ key: 'F8', mac: { key: 'F9' }, weight: 302 })]);
  expect(viewsRegistry.getViewContainer('ext-test.fallback')?.id).toBe('workbench.view.explorer');
  const container = viewContainersRegistry.get('workbench.view.extension.ext-test');
  expect(viewsRegistry.getViewContainer('ext-test.primary')).toBe(container);
  expect(service.getExtensionsStatus()['example.example'].activationEvents).toEqual(
    ['onCommand:test.ext.command', 'onView:ext-test.primary', 'onView:ext-test.fallback'],
  );
  expect(errors).toHaveBeenCalledWith(expect.stringContaining('[example.example] contributes.commands.0'));
  expect(warns).toHaveBeenCalledWith(expect.stringContaining('[example.example] contributes.views.missing'));

  expect(service.addExtension(installed)).toBe(true);
  expect(MenuRegistry.getCommand('test.ext.command')?.title).toBe('Installed');
  expect(rules().map(rule => rule.weight)).toEqual([302, 400]);
  expect(viewsRegistry.getViewContainer('ext-test.installed')).toBe(container);
  expect(service.removeExtension('EXAMPLE.INSTALLED')).toBe(true);
  expect(viewsRegistry.getViewContainer('ext-test.installed')).toBeUndefined();
  expect(MenuRegistry.getCommand('test.ext.command')?.title).toBe('Builtin');
  expect(rules()).toHaveLength(1);
  expect(service.removeExtension('example.example')).toBe(true);
  expect(rules()).toHaveLength(0);
  expect(MenuRegistry.getCommand('test.ext.command')).toBeUndefined();
  expect(viewContainersRegistry.get('workbench.view.extension.ext-test')).toBeUndefined();
  expect(viewsRegistry.getViewContainer('ext-test.fallback')).toBeUndefined();
});
