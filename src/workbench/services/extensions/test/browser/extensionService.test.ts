import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchLayoutService } from '../../../layout/browser/layoutService.js';
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
  expect(MenuRegistry.getCommand('test.bad')).toMatchObject({ title: 'bad', icon: undefined });
  expect(MenuRegistry.getMenuItems(MenuId.ViewTitle).filter(item => 'command' in item && item.command.id === 'test.ext.command'))
    .toEqual([expect.objectContaining({ group: 'navigation', order: 2 })]);
  const rules = () => KeybindingsRegistry.getDefaultKeybindings().filter(rule => rule.id === 'test.ext.command');
  expect(rules()).toEqual([expect.objectContaining({ key: 'F8', mac: { key: 'F9' }, weight: 302 })]);
  expect(viewsRegistry.getViewContainer('ext-test.fallback')?.id).toBe('workbench.view.explorer');
  const container = viewContainersRegistry.get('workbench.view.extension.ext-test');
  expect(viewsRegistry.getViewContainer('ext-test.primary')).toBe(container);
  expect(service.getExtensionsStatus()['example.example'].activationEvents).toEqual(
    ['onCommand:test.ext.command', 'onCommand:test.bad', 'onView:ext-test.primary', 'onView:ext-test.fallback'],
  );
  expect(errors).toHaveBeenCalledWith(expect.stringContaining('[example.example] contributes.commands.0'));
  expect(errors).toHaveBeenCalledWith(expect.stringContaining('[example.example] contributes.commands.2.icon'));
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

test.each([
  { proposals: ['externalUriOpener', 'multiDocumentHighlightProvider', 'documentPaste', 'externalUriOpener@2'] },
  { proposals: ['externalUriOpener', 'fixtureProposal'], unsupported: 'fixtureProposal' },
  { proposals: ['fixtureB@2', 'fixtureA', 'fixtureB@2'], unsupported: 'fixtureB@2, fixtureA' },
  { proposals: ['ExternalUriOpener', 'constructor', '__proto__'], unsupported: 'ExternalUriOpener, constructor, __proto__' },
  { proposals: [42, null, {}, 'fixtureProposal'], unsupported: 'fixtureProposal' },
  { proposals: ['', ' ', 'fixtureProposal', ''], unsupported: 'fixtureProposal' },
  { proposals: ['', '  '] },
  { proposals: [] },
  { proposals: 'externalUriOpener' },
])('reports only unsupported API proposals in $proposals', async ({ proposals, unsupported }) => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const extensionId = 'example.proposals';
  const path = 'enabledApiProposals';
  const { manifest } = validateExtensionManifest({
    name: 'proposals', publisher: 'Example', version: '1.0.0', enabledApiProposals: proposals,
  }, resolve);
  const extension: IExtensionDescription = {
    manifest: manifest!, identifier: ExtensionIdentifier.fromManifest(manifest!), isBuiltin: false, location: origin,
  };
  service = new ExtensionService(() => ({ extensions: [extension], messages: [] }));
  service.initialize();
  expect(await service.whenInstalledExtensionsRegistered()).toBe(true);

  const messages = service.getExtensionsStatus()[extensionId].messages.filter(message => message.path === path);
  if (unsupported === undefined) {
    expect(messages).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  } else {
    const message = 'Proposed APIs are not supported: ' + unsupported;
    expect(messages).toEqual([{ extensionId, severity: 'info', path, message }]);
    expect(info.mock.calls).toEqual([['[' + extensionId + '] ' + path + ': ' + message]]);
  }
});

test('rejects an incompatible extension before registering its command, view or activation events', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const base = description('future', {
    commands: [{ command: 'test.ext.future', title: 'Future' }],
    views: { explorer: [{ id: 'test.ext.future.view', name: 'Future' }] },
  });
  const extension = { ...base, manifest: { ...base.manifest, browser: './extension.js', engines: { vscode: '^2.0.0' } } };
  service = new ExtensionService(() => ({ extensions: [extension], messages: [] }));
  service.initialize();
  expect(service.extensions).toEqual([]);
  expect(service.addExtension(extension)).toBe(false);
  expect(MenuRegistry.getCommand('test.ext.future')).toBeUndefined();
  expect(viewsRegistry.getViewContainer('test.ext.future.view')).toBeUndefined();
  expect(service.getExtensionsStatus()['example.future']).toMatchObject({
    activationEvents: [],
    messages: [expect.objectContaining({ path: 'engines.vscode' })],
  });
});

test('keeps a localized view registered when an unrelated extension is added or removed', () => {
  const base = description('local-view', {
    viewsContainers: { activitybar: [{ id: 'test-local-view', title: '%label%', icon: '$(beaker)' }] },
    views: { 'test-local-view': [{ id: 'test.ext.localized', name: '%label%' }] },
  });
  const extension = { ...base, nls: { label: 'Localized view' } };
  service = new ExtensionService(() => ({ extensions: [extension], messages: [] }));
  service.initialize();
  const container = viewsRegistry.getViewContainer('test.ext.localized')!;
  const initial = viewsRegistry.getViews(container).find(view => view.id === 'test.ext.localized');
  expect(initial?.name).toBe('Localized view');
  const removed = vi.fn();
  const listener = viewsRegistry.onViewsDeregistered(removed);
  try {
    service.addExtension(description('other', {}));
    service.removeExtension('example.other');
    expect(viewsRegistry.getViews(container).find(view => view.id === 'test.ext.localized')).toBe(initial);
    expect(removed).not.toHaveBeenCalled();
  } finally {
    listener.dispose();
  }
});


test.each([['ko', 'ko'], ['en-US', 'en-us']])('registers defaults during %s translation and isolates a broken extension', async (locale, language) => {
  const base = description('good-translation', {
    commands: [{ command: 'test.ext.translateGood', title: '%good%' }],
  });
  const broken = description('broken-translation', {
    commands: [{ command: 'test.ext.translateBroken', title: '%broken%' }],
  });
  const brokenManifest = { ...broken.manifest, toJSON() { throw new Error('Cannot read translation metadata'); } };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let finish!: (content: { value: Uint8Array }) => void;
  const read = new Promise<{ value: Uint8Array }>(resolve => { finish = resolve; });
  const readFile = vi.fn(() => read);
  const instantiation = new InstantiationService(new ServiceCollection(
    [IWorkbenchLayoutService, { mainContainer: document.createElement('div') } as unknown as IWorkbenchLayoutService],
    [IConfigurationService, { getValue: () => locale } as IConfigurationService],
    [IWorkspaceContextService, { getWorkspace: () => ({ id: 'test', folders: [] }) } as unknown as IWorkspaceContextService],
    [IFileService, { readFile } as unknown as IFileService],
  ));
  const extensions: IExtensionDescription[] = [
    { ...base, nls: { good: 'Default' } },
    { ...broken, manifest: brokenManifest, nls: { broken: 'Fallback' } },
  ];
  service = new ExtensionService(() => ({ extensions, messages: [] }), instantiation);
  service.initialize();
  expect(MenuRegistry.getCommand('test.ext.translateGood')?.title).toBe('Default');
  expect(MenuRegistry.getCommand('test.ext.translateBroken')?.title).toBe('Fallback');
  expect(await service.whenInstalledExtensionsRegistered()).toBe(true);
  expect(readFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ path: expect.stringMatching('/package.nls.' + language + '.json$') }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  finish({ value: new TextEncoder().encode('{"good":"Translated"}') });
  await vi.waitFor(() => {
    expect(MenuRegistry.getCommand('test.ext.translateGood')?.title).toBe('Translated');
    expect(MenuRegistry.getCommand('test.ext.translateBroken')?.title).toBe('Fallback');
    expect(warn).toHaveBeenCalledWith('[example.broken-translation] Could not localize contributions:', expect.any(Error));
  });
});
