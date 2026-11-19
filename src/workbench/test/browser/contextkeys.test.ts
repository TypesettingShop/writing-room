import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MenuGroup } from '../../../base/browser/ui/menu/menu.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import type { FakeCodeEditor, FakeMonaco } from '../../../editor/test/browser/fakeMonaco.js';
import { resetFakeMonaco } from '../../../editor/test/browser/fakeMonaco.js';
import { MenuId, MenuRegistry } from '../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextMenuService.js';
import type { IContextMenuDelegate } from '../../../platform/contextview/browser/contextMenuService.js';
import type { ServiceIdentifier } from '../../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { InMemoryStorageService, IStorageService } from '../../../platform/storage/common/storage.js';
import { WorkbenchContextKeysHandler } from '../../browser/contextkeys.js';
import { EditorPart } from '../../browser/parts/editor/editorPart.js';
import { WelcomeEditorInput } from '../../browser/parts/editor/welcomeEditor.js';
import { GroupDirection, IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { UntitledTextEditorInput } from '../../services/untitled/common/untitledTextEditorInput.js';
import { IUntitledTextEditorService } from '../../services/untitled/common/untitledTextEditorService.js';
import '../../workbench.web.main.js';

const monaco = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../../../editor/browser/monaco.js', async () => {
  const { FakeMonaco } = await import('../../../editor/test/browser/fakeMonaco.js');
  monaco.current = new FakeMonaco();
  return { loadMonaco: async () => monaco.current };
});

class ReadonlyUntitledInput extends UntitledTextEditorInput {
  override isReadonly(): boolean { return true; }
}

const disposables = new DisposableStore();
let part: EditorPart;
let instantiation: InstantiationService;

function service<T>(id: ServiceIdentifier<T>): T {
  return instantiation.invokeFunction(accessor => accessor.get(id));
}

beforeEach(() => {
  const services = new ServiceCollection([IStorageService, disposables.add(new InMemoryStorageService())]);
  instantiation = new InstantiationService(services);
  part = instantiation.createInstance(EditorPart);
  services.set(IEditorGroupsService, part);
  const container = document.body.appendChild(document.createElement('div'));
  part.create(container);
  part.layout(1000, 600, 0, 0);
  disposables.add(part);
  disposables.add({ dispose: () => container.remove() });
  disposables.add(resetFakeMonaco(monaco.current as FakeMonaco));
  disposables.add(instantiation.createInstance(WorkbenchContextKeysHandler));
});

afterEach(() => disposables.clear());

function untitled(languageId?: string, text = ''): UntitledTextEditorInput {
  return new UntitledTextEditorInput(service(IUntitledTextEditorService).create({ languageId, initialValue: text }));
}

function root() {
  return service(IContextKeyService);
}

/** The keys as a `when` clause inside the group's active pane reads them. */
function inPane(key: string): unknown {
  const pane = part.activeGroup.activeEditorPane as { scopedContextKeyService?: { getContextKeyValue(key: string): unknown } };
  return pane.scopedContextKeyService!.getContextKeyValue(key);
}

function editorOf(): FakeCodeEditor {
  return service(ICodeEditorService).listCodeEditors().at(-1) as unknown as FakeCodeEditor;
}

test('the language, read-only and selection keys follow the model the pane shows', async () => {
  const group = part.activeGroup;
  const markdown = untitled('markdown', 'one\ntwo');
  const plain = untitled();
  await group.openEditor(markdown);
  expect(inPane('editorLangId')).toBe('markdown');
  expect(root().getContextKeyValue('resourceLangId')).toBe('markdown');
  // The pane's scope is a child of the group's: the group's keys hold inside it.
  expect(inPane('groupEditorsCount')).toBe(1);

  await group.openEditor(plain);
  expect(inPane('editorLangId')).toBe('plaintext');
  expect(root().getContextKeyValue('resourceLangId')).toBe('plaintext');
  expect(root().getContextKeyValue('resourceScheme')).toBe('untitled');
  expect(root().getContextKeyValue('resourceFilename')).toBe(plain.getName());

  // A language change of the shown model reaches both keys.
  plain.model.setLanguageId('markdown');
  expect(inPane('editorLangId')).toBe('markdown');
  expect(root().getContextKeyValue('resourceLangId')).toBe('markdown');

  expect(inPane('editorHasSelection')).toBe(false);
  editorOf().setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 });
  expect(inPane('editorHasSelection')).toBe(true);

  expect(inPane('editorReadonly')).toBe(false);
  expect(root().getContextKeyValue('activeEditorIsReadonly')).toBe(false);
  const readonly = new ReadonlyUntitledInput(service(IUntitledTextEditorService).create());
  await group.openEditor(readonly);
  expect(inPane('editorReadonly')).toBe(true);
  expect(inPane('editorHasSelection')).toBe(false);
  expect(root().getContextKeyValue('activeEditorIsReadonly')).toBe(true);

  // A pane that lets go of its model keeps nothing of it.
  await group.closeAllEditors();
  expect(root().getContextKeyValue('resourceSet')).toBe(false);
  expect(root().getContextKeyValue('resource')).toBeUndefined();
});

test('the active editor keys tell dirty and the platform', async () => {
  const input = untitled();
  await part.activeGroup.openEditor(input);
  expect(root().getContextKeyValue('activeEditorIsDirty')).toBe(false);
  input.model.textEditorModel!.setValue('changed');
  expect(root().getContextKeyValue('activeEditorIsDirty')).toBe(true);
  expect(root().getContextKeyValue('isWeb')).toBe(true);
  const platforms = ['isMac', 'isLinux', 'isWindows'].map(key => root().getContextKeyValue(key));
  expect(platforms.filter(Boolean)).toHaveLength(1);
});

test('a title button for markdown shows over a markdown editor only, per group', async () => {
  CommandsRegistry.registerCommand('test.markdownTitle', () => {});
  disposables.add(MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
    command: { id: 'test.markdownTitle', title: 'Markdown Only' }, group: 'navigation',
    when: ContextKeyExpr.deserialize('editorLangId == markdown'),
  }));
  const left = part.activeGroup;
  const button = (group = left) => group.element.querySelector('[aria-label="Markdown Only"]');
  await left.openEditor(untitled());
  await vi.waitFor(() => expect(button()).toBeNull());
  const markdown = untitled('markdown');
  await left.openEditor(markdown);
  await vi.waitFor(() => expect(button()).not.toBeNull());

  // Another group with a plain text editor does not show it, though its pane is the same kind.
  const right = part.addGroup(left, GroupDirection.RIGHT);
  await right.openEditor(untitled());
  await vi.waitFor(() => expect(button(right)).toBeNull());
  expect(button()).not.toBeNull();

  await left.closeEditor(markdown);
  await vi.waitFor(() => expect(button()).toBeNull());
});

test('a group\'s title menu reads its own editor\'s resource keys, not the active group\'s', async () => {
  CommandsRegistry.registerCommand('test.markdownResourceTitle', () => {});
  disposables.add(MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
    command: { id: 'test.markdownResourceTitle', title: 'Markdown Resource' }, group: 'navigation',
    when: ContextKeyExpr.deserialize('resourceLangId == markdown'),
  }));
  const left = part.activeGroup;
  const button = (group = left) => group.element.querySelector('[aria-label="Markdown Resource"]');
  await left.openEditor(untitled('markdown'));
  const right = part.addGroup(left, GroupDirection.RIGHT);
  await right.openEditor(untitled());
  expect(root().getContextKeyValue('resourceLangId')).toBe('plaintext');
  await vi.waitFor(() => expect(button()).not.toBeNull());
  expect(button(right)).toBeNull();
});

test('a tab context menu reads the pressed tab\'s resource, not the active one', async () => {
  CommandsRegistry.registerCommand('test.markdownTab', () => {});
  disposables.add(MenuRegistry.appendMenuItem(MenuId.EditorTitleContext, {
    command: { id: 'test.markdownTab', title: 'Markdown Tab' }, group: '9_test',
    when: ContextKeyExpr.deserialize('resourceLangId == markdown'),
  }));
  const shown: IContextMenuDelegate[] = [];
  const contextMenu = service(IContextMenuService);
  const show = vi.spyOn(contextMenu, 'showContextMenu').mockImplementation(delegate => shown.push(delegate));
  disposables.add({ dispose: () => show.mockRestore() });

  const group = part.activeGroup;
  await group.openEditor(untitled('markdown'));
  await group.openEditor(untitled());
  const tabs = group.element.querySelectorAll('.tab');
  const labels = () => (shown.at(-1)!.getActions() as readonly MenuGroup[]).flatMap(([, actions]) => actions.map(action => action.label));

  tabs[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  expect(labels()).toContain('Markdown Tab');
  tabs[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  expect(labels()).not.toContain('Markdown Tab');
  // The active editor's own keys are untouched by the menu.
  expect(root().getContextKeyValue('resourceLangId')).toBe('plaintext');

  // A tab without a resource does not show the active markdown editor's keys.
  await group.openEditor(new WelcomeEditorInput(), { inactive: true });
  await group.openEditor(group.editors[0]);
  expect(root().getContextKeyValue('resourceLangId')).toBe('markdown');
  expect(group.editors[2]).toBeInstanceOf(WelcomeEditorInput);
  group.element.querySelectorAll('.tab')[2].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  expect(labels()).not.toContain('Markdown Tab');
});

test('setContext sets a key a when clause reads, and refuses what is not plain data', async () => {
  const commands = service(ICommandService);
  await commands.executeCommand('setContext', 'test.flag', true);
  expect(root().contextMatchesRules(ContextKeyExpr.deserialize('test.flag'))).toBe(true);
  const list = ['a', 'b'];
  await commands.executeCommand('setContext', 'test.list', list);
  list.push('c');
  expect(root().contextMatchesRules(ContextKeyExpr.deserialize('test.item in test.list'))).toBe(false);
  await commands.executeCommand('setContext', 'test.item', 'c');
  // The key holds a copy: the caller's later push does not reach it.
  expect(root().contextMatchesRules(ContextKeyExpr.deserialize('test.item in test.list'))).toBe(false);
  await commands.executeCommand('setContext', 'test.item', 'b');
  expect(root().contextMatchesRules(ContextKeyExpr.deserialize('test.item in test.list'))).toBe(true);

  await expect(commands.executeCommand('setContext', 'test.fn', () => 1)).rejects.toThrow(/not plain data/);
  await expect(commands.executeCommand('setContext', 'test.date', new Date())).rejects.toThrow(/not plain data/);
  await expect(commands.executeCommand('setContext', 42, true)).rejects.toThrow(/context key name/);
  expect(root().getContextKeyValue('test.fn')).toBeUndefined();
});
