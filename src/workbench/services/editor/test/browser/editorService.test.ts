import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { $, append } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService, NullConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import type { ServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import type { IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorOpenerContribution } from '../../../../browser/parts/editor/editorOpener.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { ErrorPlaceholderEditorPane } from '../../../../browser/parts/editor/editorPlaceholder.js';
import type { Dimension } from '../../../../../base/browser/dom.js';
import type { IEditorIdentifier } from '../../../../common/editor.js';
import { ConfirmResult, EditorInput } from '../../../../common/editor/editorInput.js';
import type { IEditorCloseHandler, ISaveOptions } from '../../../../common/editor/editorInput.js';
import { ErrorEditorInput } from '../../../../common/editor/errorEditorInput.js';
import { SettingsEditorResolver } from '../../../../contrib/preferences/browser/preferences.contribution.js';
import { SettingsEditorInput } from '../../../../contrib/preferences/browser/settingsEditorInput.js';
import { UntitledTextEditorInput } from '../../../untitled/common/untitledTextEditorInput.js';
import { IUntitledTextEditorService } from '../../../untitled/common/untitledTextEditorService.js';
import { columnToEditorGroup, editorGroupToColumn } from '../../common/editorGroupColumn.js';
import { GroupDirection, GroupsOrder, IEditorGroupsService } from '../../common/editorGroupsService.js';
import type { IEditorGroup } from '../../common/editorGroupsService.js';
import {
  DEFAULT_EDITOR_ID, EDITOR_ASSOCIATIONS_SETTING, globMatchesResource, IEditorResolverService, RegisteredEditorPriority,
} from '../../common/editorResolverService.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../common/editorService.js';
import '../../../../workbench.web.main.js';

// jsdom cannot run Monaco; the untitled and settings editors get the fake.
vi.mock('../../../../../editor/browser/monaco.js', async () => {
  const { FakeMonaco } = await import('../../../../../editor/test/browser/fakeMonaco.js');
  const monaco = new FakeMonaco();
  return { loadMonaco: async () => monaco };
});

const PANE_ID = 'test.editorServicePane';
const INPUT_ID = 'test.editorServiceInput';

/** A resource input, with a close handler the test answers and a save the test controls. */
class TestInput extends EditorInput {
  answer: ConfirmResult = ConfirmResult.CANCEL;
  /** When set, `confirm` waits for it. */
  gate: Promise<void> | undefined;
  wantsConfirm = false;
  saveResult: 'saved' | 'failed' = 'saved';
  readonly asked: IEditorIdentifier[][] = [];
  readonly saves: ISaveOptions[] = [];
  reverted = 0;

  constructor(readonly target: URI, readonly via = 'direct') { super(); }
  override get typeId(): string { return INPUT_ID; }
  override get resource(): URI { return this.target; }
  override getName(): string { return this.target.path; }

  override readonly closeHandler: IEditorCloseHandler = {
    showConfirm: () => this.wantsConfirm,
    confirm: async editors => {
      this.asked.push([...editors]);
      await this.gate;
      return this.answer;
    },
  };

  override async save(_group: number, options?: ISaveOptions): Promise<EditorInput | undefined> {
    this.saves.push(options ?? {});
    return this.saveResult === 'saved' ? this : undefined;
  }

  override async revert(): Promise<void> {
    this.reverted++;
  }
}

class TestPane extends EditorPane {
  constructor() { super(PANE_ID); }
  protected createEditor(parent: HTMLElement): void { append(parent, $('.test-pane')); }
  layout(_dimension: Dimension): void {}
  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    await super.setInput(input, options);
  }
}

class TestConfiguration extends NullConfigurationService {
  readonly values = new Map<string, unknown>();
  override getValue<T>(key?: string): T | undefined { return (key === undefined ? undefined : this.values.get(key)) as never; }
}

const registry = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!;
const disposables = new DisposableStore();
let part: EditorPart;
let instantiation: InstantiationService;
let configuration: TestConfiguration;
let picks: IQuickPickItem[][];
let answerPick: (items: IQuickPickItem[]) => IQuickPickItem | undefined;

function service<T>(id: ServiceIdentifier<T>): T {
  return instantiation.invokeFunction(accessor => accessor.get(id));
}

beforeEach(() => {
  disposables.add(registry.registerEditorPane(EditorPaneDescriptor.create(TestPane, PANE_ID, 'Test'), [INPUT_ID]));
  configuration = new TestConfiguration();
  picks = [];
  answerPick = () => undefined;
  const quickInput = {
    pick: async (items: IQuickPickItem[]) => {
      picks.push(items);
      return answerPick(items);
    },
    input: async () => undefined,
  };
  const services = new ServiceCollection(
    [IStorageService, disposables.add(new InMemoryStorageService())],
    [IConfigurationService, configuration],
    [IQuickInputService, quickInput],
  );
  instantiation = new InstantiationService(services);
  part = instantiation.createInstance(EditorPart);
  services.set(IEditorGroupsService, part);
  const container = document.body.appendChild(document.createElement('div'));
  part.create(container);
  part.layout(1000, 600, 0, 0);
  disposables.add(part);
  disposables.add({ dispose: () => container.remove() });
});

afterEach(() => disposables.clear());

function registerTestEditor(glob: string, id: string, priority: RegisteredEditorPriority, canSupport?: (resource: URI) => boolean) {
  return disposables.add(service(IEditorResolverService).registerEditor(glob, { id, label: id, priority },
    { canSupportResource: canSupport }, ({ resource, options }) => ({ editor: new TestInput(resource, id), options })));
}

describe('glob matching', () => {
  test.each([
    ['*.md', 'test:/a/b/Notes.MD', true],
    ['*.md', 'test:/a/b/notes.txt', false],
    ['*.{md,markdown}', 'test:/x.markdown', true],
    ['readme.?d', 'test:/README.md', true],
    ['[!r]*.md', 'test:/readme.md', false],
    ['[a-c]*.md', 'test:/beta.md', true],
    ['test:/docs/**/*.md', 'test:/docs/a/b/c.md', true],
    ['test:/docs/**/*.md', 'test:/docs/c.md', true],
    ['test:/docs/*.md', 'test:/docs/a/c.md', false],
    ['**/*.md', 'other:/a/c.md', true],
    ['vscode-userdata:/User/settings.json', 'vscode-userdata:/User/settings.json', true],
    ['vscode-userdata:/User/settings.json', 'vscode-userdata:/User/settingsXjson', false],
    ['*', 'untitled:Untitled-1', true],
    // A character outside the BMP is one character of the name and one of the pattern.
    ['*\u{1F600}.md', 'test:/a\u{1F600}.md', true],
    ['?.md', 'test:/\u{1F600}.md', false],
  ])('%s matches %s: %s', (glob, resource, expected) => {
    expect(globMatchesResource(glob, URI.parse(resource))).toBe(expected);
  });

  test('a pattern longer than 4 KiB matches nothing, and a long input does not take long', () => {
    expect(globMatchesResource('*'.repeat(4097), URI.parse('test:/a'))).toBe(false);
    const started = performance.now();
    expect(globMatchesResource('**/*a*a*a*a*a*a*a*a*b', URI.parse(`test:/${'a'.repeat(5000)}`))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('the editor resolver', () => {
  const resource = URI.parse('test:/docs/readme.md');

  async function resolve(override?: string) {
    return service(IEditorResolverService).resolveEditor({ resource, options: { override } }, part.activeGroup);
  }

  test('picks by priority, a longer glob between equals, and lets an exclusive editor win over everything', async () => {
    registerTestEditor('*', 'catch-all', RegisteredEditorPriority.builtin);
    registerTestEditor('*.md', 'markdown-builtin', RegisteredEditorPriority.builtin);
    registerTestEditor('*.md', 'markdown-option', RegisteredEditorPriority.option);
    expect((await resolve()).editorId).toBe('markdown-builtin');

    registerTestEditor('*.md', 'markdown-default', RegisteredEditorPriority.default);
    expect((await resolve()).editorId).toBe('markdown-default');
    expect(service(IEditorResolverService).getEditors(resource).map(info => info.id))
      .toEqual(['markdown-default', 'markdown-builtin', 'catch-all', 'markdown-option']);

    configuration.values.set(EDITOR_ASSOCIATIONS_SETTING, { '*.md': 'markdown-option', '*.txt': 'catch-all' });
    expect((await resolve()).editorId).toBe('markdown-option');

    registerTestEditor('*.md', 'markdown-exclusive', RegisteredEditorPriority.exclusive);
    expect((await resolve()).editorId).toBe('markdown-exclusive');
  });

  test('an override names the editor whatever its glob, and is used up', async () => {
    registerTestEditor('*.txt', 'text-only', RegisteredEditorPriority.option);
    registerTestEditor('*.md', 'markdown', RegisteredEditorPriority.builtin);
    const resolved = await resolve('text-only');
    expect(resolved.editorId).toBe('text-only');
    expect((resolved.editor as TestInput).via).toBe('text-only');
    expect(resolved.options?.override).toBeUndefined();
  });

  test('canSupportResource narrows the glob, and the default editor is the fallback', async () => {
    registerTestEditor('*', 'not-for-test', RegisteredEditorPriority.builtin, candidate => candidate.scheme !== 'test');
    registerTestEditor('*', DEFAULT_EDITOR_ID, RegisteredEditorPriority.builtin, candidate => candidate.scheme === 'test');
    expect((await resolve()).editorId).toBe(DEFAULT_EDITOR_ID);
  });

  test('a resource nobody opens resolves to an error input, and an unknown override says which', async () => {
    const plain = await service(IEditorResolverService).resolveEditor({ resource: URI.parse('nowhere:/x') }, part.activeGroup);
    expect(plain.editor).toBeInstanceOf(ErrorEditorInput);
    expect(plain.editorId).toBeUndefined();
    expect((plain.editor as ErrorEditorInput).message).toBe('no editor is registered for nowhere:/x.');
    const missing = await resolve('nobody');
    expect((missing.editor as ErrorEditorInput).message).toContain("no editor 'nobody'");
  });
});

describe('opening by resource', () => {
  test('opens the registered editor in the group, with its options', async () => {
    registerTestEditor('*.md', 'markdown', RegisteredEditorPriority.builtin);
    const editors = service(IEditorService);
    const second = part.addGroup(part.activeGroup, GroupDirection.RIGHT);
    await editors.openEditor({ resource: URI.parse('test:/a.md'), options: { preserveFocus: true } }, second);
    expect(second.activeEditor).toBeInstanceOf(TestInput);
    expect((second.activeEditor as TestInput).via).toBe('markdown');
    expect(second.activeEditorPane?.id).toBe(PANE_ID);
  });

  test('an unopenable resource shows an error editor, not an empty pane', async () => {
    const editors = service(IEditorService);
    await editors.openEditor({ resource: URI.parse('nowhere:/x') });
    const group = part.activeGroup;
    expect(group.activeEditor).toBeInstanceOf(ErrorEditorInput);
    expect(group.activeEditorPane?.id).toBe(ErrorPlaceholderEditorPane.ID);
    expect(group.element.querySelector('[role="alert"]')?.textContent)
      .toBe('The editor could not be opened: no editor is registered for nowhere:/x.');
  });

  test('untitled and settings resources open their own inputs', async () => {
    disposables.add(instantiation.createInstance(SettingsEditorResolver));
    const editors = service(IEditorService);
    await editors.openEditor({ resource: URI.parse('untitled:Untitled-7') });
    expect(part.activeGroup.activeEditor).toBeInstanceOf(UntitledTextEditorInput);
    expect(part.activeGroup.activeEditor?.resource?.toString()).toBe('untitled:Untitled-7');
    await editors.openEditor({ resource: SettingsEditorInput.resource });
    expect(part.activeGroup.activeEditor).toBeInstanceOf(SettingsEditorInput);
  });

  test('an open untitled resource opened again elsewhere keeps its one input, so closing a tab keeps the text', async () => {
    const editors = service(IEditorService);
    const left = part.activeGroup;
    const input = new UntitledTextEditorInput(service(IUntitledTextEditorService).create({ initialValue: 'draft' }));
    await left.openEditor(input);
    await editors.openEditor({ resource: input.resource }, SIDE_GROUP);
    const right = part.activeGroup;
    expect(right).not.toBe(left);
    expect(right.activeEditor).toBe(input);
    await right.closeEditor(input);
    expect(left.editors).toEqual([input]);
    expect(input.isDisposed()).toBe(false);
    expect(input.model.getValue()).toBe('draft');
  });

  test('finds the editors of a resource in every group, or in one', async () => {
    const editors = service(IEditorService);
    const resource = URI.parse('test:/shared');
    const left = part.activeGroup;
    const input = new TestInput(resource);
    await left.openEditor(input);
    await left.openEditor(new TestInput(URI.parse('test:/other')));
    const right = part.addGroup(left, GroupDirection.RIGHT);
    left.copyEditor(input, right);
    expect(editors.findEditors(resource)).toEqual([{ groupId: left.id, editor: input }, { groupId: right.id, editor: input }]);
    expect(editors.findEditors(resource, right.id)).toEqual([{ groupId: right.id, editor: input }]);
    expect(editors.findEditors(URI.parse('test:/none'))).toEqual([]);
  });

  test('the visible editors change once per split, tab switch and close, and closes are reported', async () => {
    const editors = service(IEditorService);
    const visible = vi.fn();
    const closed: string[] = [];
    disposables.add({ dispose: editors.onDidVisibleEditorsChange(visible).dispose });
    disposables.add({ dispose: editors.onDidCloseEditor(({ editor, index }) => closed.push(`${editor.getName()}@${index}`)).dispose });
    const left = part.activeGroup;
    const a = new TestInput(URI.parse('test:/a'));
    const b = new TestInput(URI.parse('test:/b'));
    await left.openEditor(a);
    expect(visible).toHaveBeenCalledTimes(1);
    expect(editors.visibleEditors).toEqual([a]);

    await left.openEditor(b);
    expect(visible).toHaveBeenCalledTimes(2);
    expect(editors.visibleEditors).toEqual([b]);

    const right = part.addGroup(left, GroupDirection.RIGHT);
    // An empty group adds no visible editor.
    expect(visible).toHaveBeenCalledTimes(2);
    left.copyEditor(a, right);
    expect(visible).toHaveBeenCalledTimes(3);
    expect(editors.visibleEditors).toEqual([b, a]);
    expect(editors.visibleEditorPanes).toHaveLength(2);

    await right.closeEditor(a);
    expect(visible).toHaveBeenCalledTimes(4);
    expect(editors.visibleEditors).toEqual([b]);
    await left.closeEditor(b);
    expect(visible).toHaveBeenCalledTimes(5);
    expect(editors.visibleEditors).toEqual([a]);
    expect(closed).toEqual(['/a@0', '/b@1']);
  });
});

describe('closing with a question', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => resolve = done);
    return { promise, resolve };
  }

  test('a cancel keeps the tab and what it owns; one cancel keeps every editor of the close', async () => {
    const group = part.activeGroup;
    const asking = new TestInput(URI.parse('test:/asking'));
    const quiet = new TestInput(URI.parse('test:/quiet'));
    await group.openEditor(quiet);
    await group.openEditor(asking);
    asking.wantsConfirm = true;

    expect(await group.closeEditor(asking)).toBe(false);
    expect(group.editors).toEqual([quiet, asking]);
    expect(asking.isDisposed()).toBe(false);
    expect(await group.closeAllEditors()).toBe(false);
    expect(group.editors).toEqual([quiet, asking]);
    expect(asking.asked).toEqual([[{ groupId: group.id, editor: asking }], [{ groupId: group.id, editor: asking }]]);
  });

  test('without a question the editor is gone before the call returns, as v0.1.0 closed', () => {
    const group = part.activeGroup;
    const input = new TestInput(URI.parse('test:/sync'));
    void group.openEditor(input);
    void group.closeEditor(input);
    expect(group.editors).toEqual([]);
    expect(input.isDisposed()).toBe(true);
  });

  test('closing again while the question is open asks once and closes once', async () => {
    const group = part.activeGroup;
    const input = new TestInput(URI.parse('test:/twice'));
    await group.openEditor(input);
    input.wantsConfirm = true;
    input.answer = ConfirmResult.DONT_SAVE;
    const gate = deferred();
    input.gate = gate.promise;

    const first = group.closeEditor(input);
    const second = group.closeEditor(input);
    expect(group.editors).toEqual([input]);
    gate.resolve();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(input.asked).toHaveLength(1);
    expect(input.reverted).toBe(1);
    expect(group.editors).toEqual([]);
  });

  test('a group that goes away while the question is open closes nothing more', async () => {
    const left = part.activeGroup;
    await left.openEditor(new TestInput(URI.parse('test:/stay')));
    const right = part.addGroup(left, GroupDirection.RIGHT);
    const input = new TestInput(URI.parse('test:/moving'));
    await right.openEditor(input);
    input.wantsConfirm = true;
    input.answer = ConfirmResult.DONT_SAVE;
    const gate = deferred();
    input.gate = gate.promise;

    const closing = right.closeEditor(input);
    // The group is merged away meanwhile, which moves the editor without asking.
    part.mergeGroup(right, left);
    gate.resolve();
    expect(await closing).toBe(false);
    expect(left.editors).toContain(input);
    expect(input.isDisposed()).toBe(false);
  });

  test('save closes once the save succeeded; a failed save keeps the tab', async () => {
    const group = part.activeGroup;
    const input = new TestInput(URI.parse('test:/save'));
    await group.openEditor(input);
    input.wantsConfirm = true;
    input.answer = ConfirmResult.SAVE;
    input.saveResult = 'failed';
    expect(await group.closeEditor(input)).toBe(false);
    expect(group.editors).toEqual([input]);
    input.saveResult = 'saved';
    expect(await group.closeEditor(input)).toBe(true);
    expect(input.saves).toEqual([{ reason: 'explicit' }, { reason: 'explicit' }]);
    expect(group.editors).toEqual([]);
  });

  test('an editor disposed while the Save question is open lets the rest of the close go on', async () => {
    const group = part.activeGroup;
    const gone = new TestInput(URI.parse('test:/gone'));
    const other = new TestInput(URI.parse('test:/other'));
    await group.openEditor(other);
    await group.openEditor(gone);
    gone.wantsConfirm = true;
    gone.answer = ConfirmResult.SAVE;
    const gate = deferred();
    gone.gate = gate.promise;

    const closing = group.closeAllEditors();
    gone.dispose();
    gate.resolve();
    expect(await closing).toBe(true);
    expect(group.editors).toEqual([]);
    expect(gone.saves).toEqual([]);
  });

  test('no question while another group still shows the editor', async () => {
    const left = part.activeGroup;
    const input = new TestInput(URI.parse('test:/split'));
    await left.openEditor(input);
    const right = part.addGroup(left, GroupDirection.RIGHT);
    left.copyEditor(input, right);
    input.wantsConfirm = true;
    expect(await right.closeEditor(input)).toBe(true);
    expect(input.asked).toEqual([]);
    expect(await left.closeEditor(input)).toBe(false);
    expect(input.asked).toHaveLength(1);
  });
});

describe('the save command', () => {
  test('saves the active editor through its input, and a tab context names another', async () => {
    const commands = service(ICommandService);
    const group = part.activeGroup;
    const a = new TestInput(URI.parse('test:/a'));
    const b = new TestInput(URI.parse('test:/b'));
    await group.openEditor(a);
    await group.openEditor(b);
    await commands.executeCommand('workbench.action.files.save');
    expect([a.saves, b.saves]).toEqual([[], [{ reason: 'explicit' }]]);
    await commands.executeCommand('workbench.action.files.save', { groupId: group.id, editorIndex: 0 });
    expect(a.saves).toEqual([{ reason: 'explicit' }]);
  });
});

describe('view columns', () => {
  test('map to groups in screen order, adding one group to the right past the last', () => {
    const groups = service(IEditorGroupsService);
    const first = part.activeGroup;
    const left = part.addGroup(first, GroupDirection.LEFT);
    expect(columnToEditorGroup(groups, ACTIVE_GROUP)).toBe(ACTIVE_GROUP);
    expect(columnToEditorGroup(groups, SIDE_GROUP)).toBe(SIDE_GROUP);
    expect(columnToEditorGroup(groups, 0)).toBe(left.id);
    expect(columnToEditorGroup(groups, 1)).toBe(first.id);
    expect(editorGroupToColumn(groups, first)).toBe(1);

    const added = columnToEditorGroup(groups, 5);
    expect(part.count).toBe(3);
    expect(part.getGroups(GroupsOrder.GRID_APPEARANCE).map((group: IEditorGroup) => group.id)).toEqual([left.id, first.id, added]);
    expect(editorGroupToColumn(groups, added as number)).toBe(2);
    expect(columnToEditorGroup(groups, 9)).toBe(SIDE_GROUP);
    expect(columnToEditorGroup(groups, -3)).toBe(SIDE_GROUP);
    expect(part.count).toBe(3);
  });
});

describe('the opener', () => {
  beforeEach(() => {
    disposables.add(instantiation.createInstance(EditorOpenerContribution));
  });

  test('opens a web address in a new tab only after the user saw it and agreed', async () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    disposables.add({ dispose: () => open.mockRestore() });
    const opener = service(IOpenerService);

    answerPick = items => items.find(item => item.label === 'Cancel');
    expect(await opener.open('https://example.com/a?b=1#c')).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(picks[0][0].detail).toBe('https://example.com/a?b=1#c');

    answerPick = items => items.find(item => item.label === 'Open');
    expect(await opener.open(URI.parse('mailto:someone@example.com'))).toBe(true);
    expect(open).toHaveBeenCalledWith('mailto:someone@example.com', '_blank', 'noopener,noreferrer');
  });

  test('refuses script and data addresses, and schemes nobody opens, without asking', async () => {
    const opener = service(IOpenerService);
    for (const target of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'nowhere:/x', 'not a uri']) {
      expect(await opener.open(target), target).toBe(false);
    }
    expect(picks).toEqual([]);
  });

  test('runs a command link only when the caller allows that command', async () => {
    const opener = service(IOpenerService);
    const commands = service(ICommandService);
    const run = vi.spyOn(commands, 'executeCommand').mockResolvedValue(undefined);
    disposables.add({ dispose: () => run.mockRestore() });
    const link = `command:test.run?${encodeURIComponent(JSON.stringify(['x', 2]))}`;
    expect(await opener.open(link)).toBe(false);
    expect(await opener.open(link, { allowCommands: ['other'] })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(await opener.open(link, { allowCommands: ['test.run'] })).toBe(true);
    expect(run).toHaveBeenCalledWith('test.run', 'x', 2);

    // Text that decodes to broken JSON is read again as written, as VS Code does.
    expect(await opener.open('command:test.run?["a%22b"]', { allowCommands: ['test.run'] })).toBe(true);
    expect(run).toHaveBeenLastCalledWith('test.run', 'a%22b');
  });

  test('passes on a resource that only an option editor takes, which is never picked by default', async () => {
    registerTestEditor('*.optonly', 'test.optionOnly', RegisteredEditorPriority.option);
    expect(await service(IOpenerService).open('test:/a.optonly')).toBe(false);
    expect(part.activeGroup.editors).toEqual([]);
  });

  test('opens a resource an editor takes, beside the active group when asked', async () => {
    const opener = service(IOpenerService);
    expect(await opener.open('untitled:Untitled-3', { openToSide: true })).toBe(true);
    expect(part.count).toBe(2);
    expect(part.activeGroup.activeEditor?.resource?.toString()).toBe('untitled:Untitled-3');
  });
});
