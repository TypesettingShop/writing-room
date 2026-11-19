import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService, NullConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../../platform/extensions/common/extensions.js';
import type { ServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import type { IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IWorkspaceContextService as IWorkspace, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { FileEditorResolverContribution } from '../../../files/browser/editors/fileEditorHandler.js';
import { FileEditorInput } from '../../../files/browser/editors/fileEditorInput.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import {
  DEFAULT_EDITOR_ID, EDITOR_ASSOCIATIONS_SETTING, IEditorResolverService, RegisteredEditorPriority,
} from '../../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { UntitledTextEditorInput } from '../../../../services/untitled/common/untitledTextEditorInput.js';
import { IUntitledTextEditorService } from '../../../../services/untitled/common/untitledTextEditorService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { ExtensionMessageCollector } from '../../../../services/extensions/common/extensionsRegistry.js';
import type { IExtensionPointUser } from '../../../../services/extensions/common/extensionsRegistry.js';
import { CONTEXT_ACTIVE_CUSTOM_EDITOR_ID, CustomEditorContributions } from '../../common/customEditor.js';
import { acceptCustomEditors } from '../../common/extensionPoint.js';
import { CustomEditorInput } from '../../browser/customEditorInput.js';
import { CustomEditorService } from '../../browser/customEditors.js';
import { ICustomEditorService } from '../../browser/customEditorService.js';
import type { ICustomEditorProvider } from '../../browser/customEditorService.js';
import { REOPEN_WITH_COMMAND_ID } from '../../browser/customEditor.contribution.js';
import '../../../../workbench.web.main.js';

vi.mock('../../../../../editor/browser/monaco.js', async () => {
  const { FakeMonaco } = await import('../../../../../editor/test/browser/fakeMonaco.js');
  const monaco = new FakeMonaco();
  return { loadMonaco: async () => monaco };
});

// jsdom has no ResizeObserver; the Webview overlay only needs one to exist.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const root = URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace' });
const file = (path: string) => URI.joinPath(root, path);
const folder: IWorkspaceFolder = { uri: root, name: 'workspace', index: 0, toResource: path => URI.joinPath(root, path) };
const workspace: IWorkspace = {
  _serviceBrand: undefined,
  onDidChangeWorkspaceFolders: Event.None,
  getWorkbenchState: () => 2,
  getWorkspace: () => ({ id: 'test', folders: [folder] }),
  getWorkspaceFolder: resource => resource.path.startsWith('/workspace') ? folder : null,
};

class TestConfiguration extends NullConfigurationService {
  readonly values = new Map<string, unknown>();
  override getValue<T>(key?: string): T | undefined { return (key === undefined ? undefined : this.values.get(key)) as never; }
}

function extension(id: string, customEditors: unknown, displayName?: string): IExtensionDescription {
  const [publisher, name] = id.split('.');
  return {
    identifier: { value: id } as IExtensionDescription['identifier'], location: `https://example.test/${id}/`, isBuiltin: false,
    manifest: { publisher: publisher!, name: name!, version: '1.0.0', displayName, contributes: { customEditors } },
  };
}

let disposables: DisposableStore;
let instantiation: InstantiationService;
let services: ServiceCollection;
let configuration: TestConfiguration;
let contributions: CustomEditorContributions;
let part: EditorPart;
let customEditors: CustomEditorService;
let activated: string[];
let onActivate: (event: string) => void;
let messages: IExtensionMessage[];
let events: Map<string, Set<string>>;
let notices: string[];
let answerPick: (items: readonly IQuickPickItem[]) => IQuickPickItem | undefined;
let picks: IQuickPickItem[][];

function service<T>(id: ServiceIdentifier<T>): T {
  return instantiation.invokeFunction(accessor => accessor.get(id));
}

function contribute(...extensions: IExtensionDescription[]) {
  const users: IExtensionPointUser<readonly unknown[]>[] = extensions.map(description => ({
    description, value: description.manifest.contributes!.customEditors as unknown[],
    collector: new ExtensionMessageCollector(description.identifier.value, message => messages.push(message)),
  }));
  return disposables.add(acceptCustomEditors(users, {
    addActivationEvent: (id, event) => {
      const set = events.get(id) ?? new Set();
      set.add(event);
      events.set(id, set);
    },
  }, contributions));
}

function provide(viewType: string, overrides: Partial<ICustomEditorProvider> = {}) {
  const provider: ICustomEditorProvider = {
    extensionId: 'test.ext', kind: 'text', options: {}, supportsMultipleEditorsPerDocument: false,
    resolve: vi.fn(async () => {}), ...overrides,
  };
  return { provider, registration: disposables.add(customEditors.registerProvider(viewType, provider)) };
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

beforeEach(async () => {
  disposables = new DisposableStore();
  activated = [];
  onActivate = () => {};
  messages = [];
  events = new Map();
  notices = [];
  picks = [];
  answerPick = () => undefined;
  configuration = new TestConfiguration();
  contributions = new CustomEditorContributions();
  const files = disposables.add(new FileService());
  files.registerProvider('vscode-vfs', disposables.add(new InMemoryFileSystemProvider()));
  files.registerProvider('vscode-userdata', disposables.add(new InMemoryFileSystemProvider()));
  for (const path of ['a.md', 'b.png', 'c.gif', 'notes/n.md', 'other/n.md', 'plain.txt']) {
    await files.writeFile(file(path), new TextEncoder().encode('# ' + path));
  }
  const extensions = {
    _serviceBrand: undefined,
    activateByEvent: async (event: string) => { activated.push(event); onActivate(event); },
    activationEventIsDone: () => true,
    whenInstalledExtensionsRegistered: async () => true,
  };
  const notifications = {
    info: (message: string) => { notices.push(message); return {}; },
    warn: (message: string) => { notices.push(message); return {}; },
    error: (message: string) => { notices.push(message); return {}; },
  };
  const quickInput = {
    pick: async (items: IQuickPickItem[]) => { picks.push(items); return answerPick(items); },
    input: async () => undefined,
  };
  const container = document.body.appendChild(document.createElement('div'));
  disposables.add({ dispose: () => container.remove() });
  const layout = { mainContainer: container, onDidChangePartVisibility: Event.None };
  services = new ServiceCollection(
    [IWorkbenchLayoutService, layout],
    [IStorageService, disposables.add(new InMemoryStorageService())],
    [IConfigurationService, configuration],
    [IFileService, files],
    [IWorkspaceContextService, workspace],
    [IExtensionService, extensions],
    [INotificationService, notifications],
    [IQuickInputService, quickInput],
  );
  instantiation = new InstantiationService(services);
  part = disposables.add(instantiation.createInstance(EditorPart));
  services.set(IEditorGroupsService, part);
  part.create(container);
  part.layout(1000, 600, 0, 0);
  disposables.add(instantiation.createInstance(FileEditorResolverContribution));
  customEditors = disposables.add(instantiation.createInstance(CustomEditorService, contributions));
  services.set(ICustomEditorService, customEditors);
});

afterEach(() => disposables.dispose());

function reopenWith(context?: unknown) {
  return instantiation.invokeFunction(accessor => CommandsRegistry.getCommand(REOPEN_WITH_COMMAND_ID)!.handler(accessor, context));
}

async function opened(path: string) {
  return service(IEditorResolverService).resolveEditor({ resource: file(path) }, part.activeGroup);
}

describe('the customEditors contribution', () => {
  test('reads each entry, takes builtin as default, adds the implicit activation event and refuses a taken viewType', () => {
    contribute(
      extension('pub.one', [
        { viewType: 'one.preview', displayName: 'Preview', selector: [{ filenamePattern: '*.md' }], priority: 'option' },
        { viewType: 'one.images', displayName: 'Images', selector: [{ filenamePattern: '*.{jpg,png}' }, { nope: 1 }], priority: 'builtin' },
        { viewType: 'one.odd', displayName: 'Odd', selector: [], priority: 'sometimes' },
        { displayName: 'Nameless', selector: [] },
      ], 'One'),
      extension('pub.two', [{ viewType: 'one.preview', displayName: 'Copy', selector: [{ filenamePattern: '*.md' }] }]),
    );
    expect(contributions.editors.map(info => [info.id, info.priority, info.providerDisplayName, info.filenamePatterns]))
      .toEqual([
        ['one.preview', 'option', 'One', ['*.md']],
        ['one.images', 'default', 'One', ['*.{jpg,png}']],
        ['one.odd', 'default', 'One', []],
      ]);
    expect([...events.get('pub.one')!]).toEqual(['onCustomEditor:one.preview', 'onCustomEditor:one.images', 'onCustomEditor:one.odd']);
    expect(events.get('pub.two')).toBeUndefined();
    expect(messages.map(message => [message.extensionId, message.severity, message.path])).toEqual([
      ['pub.one', 'warn', 'contributes.customEditors[1].selector[1]'],
      ['pub.one', 'warn', 'contributes.customEditors[2].priority'],
      ['pub.one', 'error', 'contributes.customEditors[3].viewType'],
      ['pub.two', 'error', 'contributes.customEditors[0].viewType'],
    ]);
  });
});

describe('choosing the editor', () => {
  test('an option editor opens only when asked; a sole default editor opens by default', async () => {
    contribute(extension('pub.one', [
      { viewType: 'one.preview', displayName: 'Preview', selector: [{ filenamePattern: '*.md' }], priority: 'option' },
      { viewType: 'one.images', displayName: 'Images', selector: [{ filenamePattern: '*.{jpg,png}' }] },
    ]));
    await settle();
    provide('one.preview');
    provide('one.images');
    expect((await opened('a.md')).editorId).toBe(DEFAULT_EDITOR_ID);
    const image = await opened('b.png');
    expect(image.editorId).toBe('one.images');
    expect(image.editor).toBeInstanceOf(CustomEditorInput);
    expect(activated).toContain('onCustomEditor:one.images');
    expect((await opened('c.gif')).editorId).toBe(DEFAULT_EDITOR_ID);
    expect(service(IEditorResolverService).getEditors(file('a.md')).map(info => [info.id, info.priority]))
      .toEqual([[DEFAULT_EDITOR_ID, RegisteredEditorPriority.builtin], ['one.preview', RegisteredEditorPriority.option]]);
  });

  test('two default editors for one file leave it to the text editor, and both stay on offer', async () => {
    contribute(
      extension('pub.one', [{ viewType: 'one.md', displayName: 'One', selector: [{ filenamePattern: '*.md' }] }]),
      extension('pub.two', [{ viewType: 'two.md', displayName: 'Two', selector: [{ filenamePattern: 'a.md' }] }]),
    );
    await settle();
    provide('one.md');
    provide('two.md');
    expect((await opened('a.md')).editorId).toBe(DEFAULT_EDITOR_ID);
    expect((await opened('notes/n.md')).editorId).toBe('one.md');
    expect(service(IEditorResolverService).getEditors(file('a.md')).map(info => info.id).sort())
      .toEqual([DEFAULT_EDITOR_ID, 'one.md', 'two.md']);
  });

  test('an association wins over the rule; an unknown id in it is passed over, not thrown', async () => {
    contribute(extension('pub.one', [
      { viewType: 'one.preview', displayName: 'Preview', selector: [{ filenamePattern: '*.md' }], priority: 'option' },
      { viewType: 'one.images', displayName: 'Images', selector: [{ filenamePattern: '*.png' }] },
    ]));
    await settle();
    provide('one.preview');
    provide('one.images');
    configuration.values.set(EDITOR_ASSOCIATIONS_SETTING, { '*.md': 'one.preview', '*.png': DEFAULT_EDITOR_ID });
    expect((await opened('a.md')).editorId).toBe('one.preview');
    expect((await opened('b.png')).editorId).toBe(DEFAULT_EDITOR_ID);
    configuration.values.set(EDITOR_ASSOCIATIONS_SETTING, { '*.md': 'nobody.knows', '*.png': 'nobody.either' });
    expect((await opened('a.md')).editorId).toBe(DEFAULT_EDITOR_ID);
    expect((await opened('b.png')).editorId).toBe('one.images');
  });

  test('a pattern with a slash is matched against the path', async () => {
    contribute(extension('pub.one', [
      { viewType: 'one.notes', displayName: 'Notes', selector: [{ filenamePattern: '**/notes/*.md' }] },
    ]));
    await settle();
    provide('one.notes');
    expect((await opened('notes/n.md')).editorId).toBe('one.notes');
    expect((await opened('other/n.md')).editorId).toBe(DEFAULT_EDITOR_ID);
  });

  test('without a provider after activation the file opens as text, told once', async () => {
    contribute(extension('pub.one', [{ viewType: 'one.png', displayName: 'Images', selector: [{ filenamePattern: '*.md' }] }]));
    await settle();
    const first = await opened('a.md');
    expect(first.editor).toBeInstanceOf(FileEditorInput);
    expect(activated).toEqual(['onCustomEditor:one.png']);
    await opened('notes/n.md');
    expect(notices).toHaveLength(1);
  });

  test('editors of a removed extension leave the resolver, and their open tabs become text editors', async () => {
    const contributed = contribute(extension('pub.one', [{ viewType: 'one.md', displayName: 'One', selector: [{ filenamePattern: '*.md' }] }]));
    await settle();
    provide('one.md');
    await service(IEditorService).openEditor({ resource: file('a.md') });
    expect(part.activeGroup.activeEditor).toBeInstanceOf(CustomEditorInput);
    contributed.dispose();
    await settle();
    expect(service(IEditorResolverService).getEditors(file('a.md')).map(info => info.id)).toEqual([DEFAULT_EDITOR_ID]);
    expect(part.activeGroup.activeEditor).toBeInstanceOf(FileEditorInput);
    expect(part.activeGroup.editors).toHaveLength(1);
  });

  test('a contribution list replaced in one step does not reopen anything', async () => {
    contribute(extension('pub.one', [{ viewType: 'one.md', displayName: 'One', selector: [{ filenamePattern: '*.md' }] }]));
    await settle();
    provide('one.md');
    await service(IEditorService).openEditor({ resource: file('a.md') });
    const input = part.activeGroup.activeEditor;
    // The extension point disposes the old list and sets the new one in one go.
    contributions.set([...contributions.editors]);
    await settle();
    expect(part.activeGroup.activeEditor).toBe(input);
  });
});

describe('the open editors', () => {
  beforeEach(async () => {
    contribute(extension('pub.one', [
      { viewType: 'one.preview', displayName: 'Preview', selector: [{ filenamePattern: '*.md' }], priority: 'option' },
    ], 'One'));
    await settle();
  });

  test('a second open of one resource reveals the open editor, moving it to the group asked for', async () => {
    provide('one.preview');
    const editors = service(IEditorService);
    await editors.openEditor({ resource: file('a.md'), options: { override: 'one.preview' } });
    const first = part.activeGroup.activeEditor;
    await editors.openEditor({ resource: file('a.md'), options: { override: 'one.preview' } });
    expect(part.activeGroup.editors).toEqual([first]);
    const side = part.addGroup(part.activeGroup, 3 /* GroupDirection.RIGHT */);
    await editors.openEditor({ resource: file('a.md'), options: { override: 'one.preview' } }, side);
    expect(side.editors).toEqual([first]);
    expect(part.groups.flatMap(group => group.editors).filter(editor => editor === first)).toHaveLength(1);
  });

  test('a provider that allows more opens one editor per request', async () => {
    provide('one.preview', { supportsMultipleEditorsPerDocument: true });
    const editors = service(IEditorService);
    await editors.openEditor({ resource: file('a.md'), options: { override: 'one.preview' } });
    const side = part.addGroup(part.activeGroup, 3);
    await editors.openEditor({ resource: file('a.md'), options: { override: 'one.preview' } }, side);
    const inputs = part.groups.flatMap(group => group.editors);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).not.toBe(inputs[1]);
  });

  test('activeCustomEditorId follows the active editor', async () => {
    provide('one.preview');
    const key = () => service(IContextKeyService).getContextKeyValue(CONTEXT_ACTIVE_CUSTOM_EDITOR_ID.key);
    await service(IEditorService).openEditor({ resource: file('a.md'), options: { override: 'one.preview' } });
    expect(key()).toBe('one.preview');
    await service(IEditorService).openEditor({ resource: file('plain.txt') });
    expect(key()).toBeUndefined();
  });

  test('Reopen Editor With lists the editors of the resource, marks the current one and swaps in place', async () => {
    const { provider } = provide('one.preview');
    const editors = service(IEditorService);
    await editors.openEditor({ resource: file('plain.txt') });
    await editors.openEditor({ resource: file('a.md') });
    await editors.openEditor({ resource: file('notes/n.md') });
    const group = part.activeGroup;
    group.openEditor(group.editors[1]!);
    const text = group.editors[1] as FileEditorInput;
    const model = await text.resolve();
    model.textEditorModel!.setValue('changed');
    expect(text.isDirty()).toBe(true);

    answerPick = items => items.find(item => item.id === 'one.preview');
    await reopenWith({ groupId: group.id, editorIndex: 1 });
    expect(picks[0]!.map(item => [item.id, item.label, item.description])).toEqual([
      [DEFAULT_EDITOR_ID, 'Text Editor', 'Active'], ['one.preview', 'Preview', undefined],
    ]);
    const custom = group.editors[1];
    expect(custom).toBeInstanceOf(CustomEditorInput);
    expect(group.editors).toHaveLength(3);
    expect(group.activeEditor).toBe(custom);
    expect(custom!.isDirty()).toBe(true);
    await settle();
    expect(provider.resolve).toHaveBeenCalledTimes(1);
    expect((await (custom as CustomEditorInput).acquireModel()).getValue()).toBe('changed');

    answerPick = items => items.find(item => item.id === DEFAULT_EDITOR_ID);
    await reopenWith();
    expect(picks[1]!.find(item => item.description === 'Active')?.id).toBe('one.preview');
    expect(group.editors[1]).toBeInstanceOf(FileEditorInput);
    expect(group.editors[1]!.isDirty()).toBe(true);
    expect(custom!.isDisposed()).toBe(true);
  });

  test('untitled text keeps its text when Reopen With puts a custom editor in its place, and goes with the last editor', async () => {
    provide('one.preview');
    contributions.set([{ ...contributions.editors[0]!, filenamePatterns: ['Untitled-*'] }]);
    await settle();
    const untitled = service(IUntitledTextEditorService);
    const model = untitled.create({ initialValue: 'draft' });
    const group = part.activeGroup;
    await group.openEditor(instantiation.createInstance(UntitledTextEditorInput, model));
    await model.resolve();
    answerPick = items => items.find(item => item.id === 'one.preview');
    await reopenWith();
    const custom = group.activeEditor as CustomEditorInput;
    expect(custom).toBeInstanceOf(CustomEditorInput);
    expect(custom.resource.toString()).toBe(model.resource.toString());
    await settle();
    expect((await custom.acquireModel()).getValue()).toBe('draft');
    expect(custom.isDirty()).toBe(true);
    custom.dispose();
    await settle();
    expect(untitled.get(model.resource)).toBeUndefined();
  });
});
