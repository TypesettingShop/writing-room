import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { $, append } from '../../../../../base/browser/dom.js';
import type { Dimension } from '../../../../../base/browser/dom.js';
import { Orientation } from '../../../../../base/browser/ui/grid/grid.js';
import type { ISerializedNode } from '../../../../../base/browser/ui/grid/grid.js';
import { formatKeybinding } from '../../../../../base/common/keybindingLabels.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { IEditorOptions, ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { KeybindingResolver } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../../../browser/editor.js';
import { DEFAULT_EDITOR_PART_OPTIONS, getEditorPartOptions, setEditorPartOptionsProvider } from '../../../../browser/parts/editor/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import type { IEditorCommandsContext } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { GroupDirection, GroupsOrder, IEditorGroupsService } from '../../common/editorGroupsService.js';
import type { IEditorGroup } from '../../common/editorGroupsService.js';
import '../../../../workbench.web.main.js';

const PANE_ID = 'test.groupsServicePane';
const INPUT_ID = 'test.groupsServiceInput';
const OTHER_PANE_ID = 'test.groupsServiceOtherPane';
const OTHER_INPUT_ID = 'test.groupsServiceOtherInput';

class TestInput extends EditorInput {
  constructor(readonly name: string, private readonly type = INPUT_ID) { super(); }
  override get typeId(): string { return this.type; }
  override get resource(): undefined { return undefined; }
  override getName(): string { return this.name; }
}

/** A pane that keeps the view state ("the cursor") of each input it showed, as the text pane does. */
class BaseTestPane extends EditorPane {
  static readonly created: BaseTestPane[] = [];
  readonly viewStates = new Map<EditorInput, object>();
  readonly opened: { input: EditorInput; options: ITextEditorOptions | undefined }[] = [];
  readonly layouts: Dimension[] = [];
  focused = 0;
  element!: HTMLElement;

  constructor(id: string) {
    super(id);
    BaseTestPane.created.push(this);
  }

  protected createEditor(parent: HTMLElement): void {
    this.element = append(parent, $('.test-pane'));
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    const viewState = (options as ITextEditorOptions | undefined)?.viewState;
    if (viewState) {
      this.viewStates.set(input, viewState);
    }
    this.opened.push({ input, options });
    await super.setInput(input, options);
  }

  layout(dimension: Dimension): void {
    this.layouts.push(dimension);
  }

  override focus(): void {
    this.focused++;
  }

  override getViewState(input = this.input): object | undefined {
    return input && this.viewStates.get(input);
  }
}

class TestPane extends BaseTestPane {
  constructor() { super(PANE_ID); }
}

class OtherPane extends BaseTestPane {
  constructor() { super(OTHER_PANE_ID); }
}

const registry = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!;
const disposables = new DisposableStore();

let part: EditorPart;
let instantiation: InstantiationService;

beforeEach(() => {
  disposables.add(registry.registerEditorPane(EditorPaneDescriptor.create(TestPane, PANE_ID, 'Test'), [INPUT_ID]));
  disposables.add(registry.registerEditorPane(EditorPaneDescriptor.create(OtherPane, OTHER_PANE_ID, 'Other'), [OTHER_INPUT_ID]));
  const services = new ServiceCollection();
  instantiation = new InstantiationService(services);
  part = instantiation.createInstance(EditorPart);
  services.set(IEditorGroupsService, part);
  const container = document.body.appendChild(document.createElement('div'));
  part.create(container);
  part.layout(1000, 600, 0, 0);
  disposables.add(part);
  disposables.add({ dispose: () => container.remove() });
  BaseTestPane.created.length = 0;
});

afterEach(() => disposables.clear());

/** The grid as nested arrays of group ids, rows and columns alternating from the root. */
function shape(): unknown[] {
  const toShape = (node: ISerializedNode): unknown => node.type === 'branch'
    ? node.data.map(toShape)
    : (node.data as { id: number }).id;
  const root = part.createState().serializedGrid.root;
  return root.type === 'branch' ? root.data.map(toShape) : [];
}

function width(group: IEditorGroup): number {
  return Number.parseFloat(group.element.style.width);
}

function height(group: IEditorGroup): number {
  return Number.parseFloat(group.element.style.height);
}

async function open(group: IEditorGroup, ...names: string[]): Promise<TestInput[]> {
  const inputs = names.map(name => new TestInput(name));
  for (const input of inputs) {
    await group.openEditor(input);
  }
  return inputs;
}

describe('the grid of groups', () => {
  test('a split to the right gives two side-by-side groups that fill the part', () => {
    const first = part.activeGroup;
    const second = part.addGroup(first, GroupDirection.RIGHT);
    expect(part.count).toBe(2);
    expect(shape()).toEqual([first.id, second.id]);
    expect([width(first), width(second)]).toEqual([500, 500]);
    expect([height(first), height(second)]).toEqual([600, 600]);
    expect(second.element.dataset.groupId).toBe(String(second.id));
    expect(second.id).toBeGreaterThan(first.id);
  });

  test('splitting the right group down nests it in a column, and removing the middle of three leaves no hole', () => {
    const first = part.activeGroup;
    const second = part.addGroup(first, GroupDirection.RIGHT);
    const third = part.addGroup(second, GroupDirection.DOWN);
    expect(shape()).toEqual([first.id, [second.id, third.id]]);
    expect([width(third), height(second), height(third)]).toEqual([500, 300, 300]);

    part.removeGroup(third);
    // The column of one collapses back into the row.
    expect(shape()).toEqual([first.id, second.id]);

    const fourth = part.addGroup(second, GroupDirection.RIGHT);
    expect(shape()).toEqual([first.id, second.id, fourth.id]);
    part.removeGroup(second);
    expect(shape()).toEqual([first.id, fourth.id]);
    expect(width(first) + width(fourth)).toBe(1000);
  });

  test('the last group cannot be removed', () => {
    const only = part.activeGroup;
    part.removeGroup(only);
    expect(part.groups).toEqual([only]);
    expect(only.disposed).toBe(false);
  });

  test('the part\'s minimum is the grid\'s: two groups side by side need twice a group\'s width', () => {
    const changes: unknown[] = [];
    part.onDidChange(change => changes.push(change));
    expect([part.minimumWidth, part.minimumHeight]).toEqual([220, 70]);
    part.addGroup(part.activeGroup, GroupDirection.RIGHT);
    expect([part.minimumWidth, part.minimumHeight]).toEqual([440, 70]);
    expect(changes).toContain(undefined);
  });

  test('moving a group moves its own element, panes and all, and lays the pane out again', async () => {
    const first = part.activeGroup;
    const [a] = await open(first, 'a');
    const second = part.addGroup(first, GroupDirection.RIGHT);
    const element = first.element;
    const pane = first.activeEditorPane as BaseTestPane;
    const paneElement = pane.element;
    const layouts = pane.layouts.length;
    const moved: IEditorGroup[] = [];
    part.onDidMoveGroup(group => moved.push(group));

    part.moveGroup(first, second, GroupDirection.DOWN);
    expect(shape()).toEqual([second.id, first.id]);
    expect(part.getGroup(first.id)).toBe(first);
    expect(first.element).toBe(element);
    expect(first.activeEditorPane).toBe(pane);
    expect(pane.element).toBe(paneElement);
    expect(paneElement.isConnected).toBe(true);
    expect(first.activeEditor).toBe(a);
    expect(pane.layouts.length).toBeGreaterThan(layouts);
    expect(BaseTestPane.created).toHaveLength(1);
    expect(moved).toEqual([first]);
    expect(() => part.moveGroup(first, first, GroupDirection.LEFT)).toThrow();
  });

  test('a group found by direction is the most recently active of the groups along that edge', () => {
    const left = part.activeGroup;
    const top = part.addGroup(left, GroupDirection.RIGHT);
    const bottom = part.addGroup(top, GroupDirection.DOWN);
    part.activateGroup(bottom);
    part.activateGroup(left);
    expect(part.findGroup({ direction: GroupDirection.RIGHT }, left)).toBe(bottom);
    part.activateGroup(top);
    part.activateGroup(left);
    expect(part.findGroup({ direction: GroupDirection.RIGHT }, left)).toBe(top);
  });

  test('options providers can be disposed in any order, and a disposed one never comes back', () => {
    const first = setEditorPartOptionsProvider(() => ({ closeEmptyGroups: false }));
    const second = setEditorPartOptionsProvider(() => ({ splitSizing: 'split' }));
    first.dispose();
    expect(getEditorPartOptions()).toMatchObject({ closeEmptyGroups: true, splitSizing: 'split' });
    second.dispose();
    expect(getEditorPartOptions()).toEqual(DEFAULT_EDITOR_PART_OPTIONS);
  });

  test('groups come in creation, recent-use and grid order', () => {
    const first = part.activeGroup;
    const third = part.addGroup(first, GroupDirection.RIGHT);
    const second = part.addGroup(first, GroupDirection.RIGHT);
    part.activateGroup(third);
    part.activateGroup(first);
    expect(part.getGroups(GroupsOrder.CREATION_TIME)).toEqual([first, third, second]);
    expect(part.getGroups(GroupsOrder.GRID_APPEARANCE)).toEqual([first, second, third]);
    expect(part.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)).toEqual([first, third, second]);
  });
});

describe('removing groups', () => {
  test('removing the active group activates the most recently active one, not a neighbour, and moves focus there', async () => {
    const first = part.activeGroup;
    const second = part.addGroup(first, GroupDirection.RIGHT);
    const third = part.addGroup(second, GroupDirection.RIGHT);
    part.activateGroup(third);
    part.activateGroup(first);
    part.activateGroup(second);
    second.element.focus();
    expect(document.activeElement).toBe(second.element);

    part.removeGroup(second);
    expect(part.activeGroup).toBe(first);
    expect(document.activeElement).toBe(first.element);
    expect(part.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)).toEqual([first, third]);
  });

  test('removing a group with editors merges them, in order, into the most recently active other group', async () => {
    const first = part.activeGroup;
    const [x] = await open(first, 'x');
    const second = part.addGroup(first, GroupDirection.RIGHT);
    const third = part.addGroup(second, GroupDirection.RIGHT);
    const [a, b, c] = await open(second, 'a', 'b', 'c');
    await second.openEditor(b);
    part.activateGroup(third);
    part.activateGroup(first);
    part.activateGroup(second);

    part.removeGroup(second);
    expect(second.disposed).toBe(true);
    expect(part.groups).toEqual([first, third]);
    expect(first.editors).toEqual([x, a, b, c]);
    // The removed group was active, so its active editor stays active where it went.
    expect(first.activeEditor).toBe(b);
    expect(part.activeGroup).toBe(first);
    expect([a, b, c].some(editor => editor.isDisposed())).toBe(false);
  });

  test('closing a group\'s last editor removes it while another group is left, but never the only group', async () => {
    const first = part.activeGroup;
    const [a] = await open(first, 'a');
    const second = part.addGroup(first, GroupDirection.RIGHT);
    const [b] = await open(second, 'b');
    const removed: IEditorGroup[] = [];
    part.onDidRemoveGroup(group => removed.push(group));

    second.closeEditor(b);
    expect(removed).toEqual([second]);
    expect(part.groups).toEqual([first]);
    expect(part.activeGroup).toBe(first);

    first.closeEditor(a);
    expect(part.groups).toEqual([first]);
    expect(first.isEmpty).toBe(true);
    expect(first.activeEditorPane).toBeUndefined();
  });

  test('with closeEmptyGroups off through the options function, an emptied group stays', async () => {
    disposables.add(setEditorPartOptionsProvider(() => ({ closeEmptyGroups: false })));
    const first = part.activeGroup;
    const second = part.addGroup(first, GroupDirection.RIGHT);
    const [b] = await open(second, 'b');
    second.closeEditor(b);
    expect(part.groups).toEqual([first, second]);
    expect(second.isEmpty).toBe(true);
    // A merge still takes its emptied source away.
    const [c] = await open(second, 'c');
    part.mergeGroup(second, first);
    expect(part.groups).toEqual([first]);
    expect(first.editors).toEqual([c]);
  });
});

describe('editors in groups', () => {
  test('one pane per pane type, reused for every input of that type', async () => {
    const group = part.activeGroup;
    const [a, b] = await open(group, 'a', 'b');
    const other = new TestInput('other', OTHER_INPUT_ID);
    await group.openEditor(other);
    await group.openEditor(a);
    expect(BaseTestPane.created.map(pane => pane.id)).toEqual([PANE_ID, OTHER_PANE_ID]);
    const [pane, otherPane] = BaseTestPane.created;
    expect(pane.opened.map(entry => entry.input)).toEqual([a, b, a]);
    // The pane of another type let go of its input and is hidden.
    expect(otherPane.input).toBeUndefined();
    expect(otherPane.element.parentElement!.hidden).toBe(true);
    expect(pane.element.parentElement!.hidden).toBe(false);
    expect(group.activeEditorPane).toBe(pane);
  });

  test('a matching input activates the open editor instead of adding a tab', async () => {
    const group = part.activeGroup;
    class MatchingInput extends TestInput {
      override matches(other: EditorInput): boolean { return other instanceof MatchingInput && other.name === this.name; }
    }
    const a = new MatchingInput('a');
    await group.openEditor(a);
    await open(group, 'b');
    await group.openEditor(new MatchingInput('a'));
    expect(group.count).toBe(2);
    expect(group.activeEditor).toBe(a);
    expect(group.contains(new MatchingInput('a'), { matches: true })).toBe(true);
    expect(group.contains(new MatchingInput('a'))).toBe(false);
  });

  test('moving an editor to another group takes the same input and its view state, and creates nothing in the source', async () => {
    const first = part.activeGroup;
    const [a, b] = await open(first, 'a', 'b');
    const second = part.addGroup(first, GroupDirection.RIGHT);
    await open(second, 'c');
    const sourcePane = first.activeEditorPane as BaseTestPane;
    const sourceElement = sourcePane.element;
    // `a` is in the background: its state lives in the source pane only.
    sourcePane.viewStates.set(a, { cursor: 7 });

    expect(first.moveEditor(a, second, { index: 0 })).toBe(true);
    await Promise.resolve();
    expect(first.editors).toEqual([b]);
    expect(second.editors[0]).toBe(a);
    expect(second.activeEditor).toBe(a);
    const targetPane = second.activeEditorPane as BaseTestPane;
    expect(targetPane.opened.at(-1)).toEqual({ input: a, options: expect.objectContaining({ viewState: { cursor: 7 } }) });
    expect(targetPane.getViewState(a)).toEqual({ cursor: 7 });
    expect(sourcePane.element).toBe(sourceElement);
    expect(a.isDisposed()).toBe(false);
  });

  test('moving the focused active editor out leaves focus with it, not with the editor behind it', async () => {
    const first = part.activeGroup;
    const [a, b] = await open(first, 'a', 'b');
    const second = part.addGroup(first, GroupDirection.RIGHT);
    part.activateGroup(first);
    const sourcePane = first.activeEditorPane as BaseTestPane;
    sourcePane.element.tabIndex = -1;
    sourcePane.element.focus();
    const sourceFocused = sourcePane.focused;

    first.moveEditor(b, second);
    expect(first.activeEditor).toBe(a);
    expect(part.activeGroup).toBe(second);
    // Focus left the source at once: a source pane still loading `a` would otherwise take it back.
    expect(second.element.contains(document.activeElement)).toBe(true);
    expect(sourcePane.focused).toBe(sourceFocused);
    expect((second.activeEditorPane as BaseTestPane).focused).toBe(1);
  });

  test('when an editor\'s group becomes active, listeners already see the pane that shows it', async () => {
    const first = part.activeGroup;
    await open(first, 'a');
    const second = part.addGroup(first, GroupDirection.RIGHT);
    await second.openEditor(new TestInput('x'), { preserveFocus: true });
    part.activateGroup(first);
    const seen: (EditorInput | undefined)[] = [];
    part.onDidActiveEditorChange(() => seen.push(part.activeGroup.activeEditorPane?.input));

    const other = new TestInput('other', OTHER_INPUT_ID);
    await second.openEditor(other);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(input => input === other)).toBe(true);
  });

  test('moving the last editor out removes its group without disposing the editor', async () => {
    const first = part.activeGroup;
    const second = part.addGroup(first, GroupDirection.RIGHT);
    const [a] = await open(second, 'a');
    second.moveEditor(a, first);
    expect(part.groups).toEqual([first]);
    expect(first.activeEditor).toBe(a);
    expect(a.isDisposed()).toBe(false);
  });

  test('an input is disposed by the last group that closes it, never while a group shows it', async () => {
    const first = part.activeGroup;
    const [a] = await open(first, 'a');
    await open(first, 'b');
    const second = part.addGroup(first, GroupDirection.RIGHT);
    first.copyEditor(a, second);
    expect(second.activeEditor).toBe(a);

    first.closeEditor(a);
    expect(a.isDisposed()).toBe(false);
    expect(second.activeEditorPane?.input).toBe(a);
    second.closeEditor(a);
    expect(a.isDisposed()).toBe(true);
  });

  test('an input disposed from elsewhere leaves every group that held it', async () => {
    const first = part.activeGroup;
    const [a, b] = await open(first, 'a', 'b');
    a.dispose();
    expect(first.editors).toEqual([b]);
  });

  test('closing a background editor keeps the active editor and its pane', async () => {
    const group = part.activeGroup;
    const [a, b] = await open(group, 'a', 'b');
    const pane = group.activeEditorPane as BaseTestPane;
    const shown = pane.opened.length;
    group.closeEditor(a);
    expect(group.activeEditor).toBe(b);
    expect(pane.opened.length).toBe(shown);
    expect(a.isDisposed()).toBe(true);
  });

  test('closing the active editor shows the most recently used one in the same pane', async () => {
    const group = part.activeGroup;
    const [a, , c] = await open(group, 'a', 'b', 'c');
    await group.openEditor(a);
    await group.openEditor(c);
    group.closeEditor(c);
    expect(group.activeEditor).toBe(a);
    expect(group.activeEditorPane?.input).toBe(a);
    expect(BaseTestPane.created).toHaveLength(1);
  });

  test('closeEditors with except keeps that editor, and closeAllEditors empties the group', async () => {
    const group = part.activeGroup;
    const [, b] = await open(group, 'a', 'b', 'c');
    group.closeEditors({ except: b });
    expect(group.editors).toEqual([b]);
    expect(group.activeEditor).toBe(b);
    group.closeAllEditors();
    expect(group.isEmpty).toBe(true);
  });
});

describe('state, context keys and commands', () => {
  test('createState describes the grid, the groups and their editors, the active group and the recent order', async () => {
    const first = part.activeGroup;
    await open(first, 'a');
    const second = part.addGroup(first, GroupDirection.RIGHT);
    part.activateGroup(second);
    const state = part.createState();
    expect(state.activeGroup).toBe(second.id);
    expect(state.mostRecentActiveGroups).toEqual([second.id, first.id]);
    const root = state.serializedGrid.root;
    expect(root.type === 'branch' && root.data.map(node => node.data)).toEqual([
      // No serializer is registered for the test inputs, so the editors are left out.
      { id: first.id, editors: [], mru: [] },
      { id: second.id, editors: [], mru: [] },
    ]);
  });

  test('keeps the part\'s and each group\'s context keys current', async () => {
    const context = instantiation.invokeFunction(accessor => accessor.get(IContextKeyService));
    const first = part.activeGroup;
    expect(context.getContextKeyValue('editorIsOpen')).toBe(false);
    expect(context.getContextKeyValue('activeEditor')).toBeNull();
    expect(context.getContextKeyValue('activeEditorGroupEmpty')).toBe(true);

    await open(first, 'a', 'b');
    expect(context.getContextKeyValue('editorIsOpen')).toBe(true);
    expect(context.getContextKeyValue('activeEditor')).toBe(PANE_ID);
    expect(first.scopedContextKeyService.getContextKeyValue('groupEditorsCount')).toBe(2);
    expect(context.getContextKeyValue('activeEditorGroupEmpty')).toBe(false);

    const second = part.addGroup(first, GroupDirection.RIGHT);
    expect(context.getContextKeyValue('multipleEditorGroups')).toBe(true);
    part.activateGroup(second);
    expect(context.getContextKeyValue('activeEditor')).toBeNull();
    // As in VS Code, the key tells about the active group wherever focus is, not about the group it is read in.
    expect(context.getContextKeyValue('activeEditorGroupEmpty')).toBe(true);
    expect(first.scopedContextKeyService.getContextKeyValue('activeEditorGroupEmpty')).toBe(true);
    part.activateGroup(first);
    expect(context.getContextKeyValue('activeEditorGroupEmpty')).toBe(false);
    part.removeGroup(second);
    expect(context.getContextKeyValue('multipleEditorGroups')).toBe(false);
    expect(context.getContextKeyValue('activeEditor')).toBe(PANE_ID);
  });

  test('split commands open the same input beside its group, from its view state', async () => {
    const commands = instantiation.invokeFunction(accessor => accessor.get(ICommandService));
    const first = part.activeGroup;
    const [a, b] = await open(first, 'a', 'b');
    (first.activeEditorPane as BaseTestPane).viewStates.set(a, { cursor: 3 });

    // From a tab's context menu: the tab's editor, not the active one.
    const context: IEditorCommandsContext = { groupId: first.id, editorIndex: 0 };
    await commands.executeCommand('workbench.action.splitEditorDown', context);
    const second = part.activeGroup;
    expect(second).not.toBe(first);
    // One group split down turns the grid into a column rather than nesting one.
    expect(shape()).toEqual([first.id, second.id]);
    expect(part.createState().serializedGrid.orientation).toBe(Orientation.VERTICAL);
    expect(second.editors).toEqual([a]);
    expect((second.activeEditorPane as BaseTestPane).getViewState(a)).toEqual({ cursor: 3 });
    expect(first.editors).toEqual([a, b]);

    // Joining merges into the active group, the new one; its copy of `a` stays the one tab of `a`.
    await commands.executeCommand('workbench.action.joinAllGroups');
    expect(part.groups).toEqual([second]);
    expect(second.editors).toEqual([a, b]);
    expect([a.isDisposed(), b.isDisposed()]).toEqual([false, false]);
  });

  test('Close Others from a tab keeps that tab, and Close Editor closes a background tab without activating it', async () => {
    const commands = instantiation.invokeFunction(accessor => accessor.get(ICommandService));
    const group = part.activeGroup;
    const [a, b, c] = await open(group, 'a', 'b', 'c');
    await commands.executeCommand('workbench.action.closeActiveEditor', { groupId: group.id, editorIndex: 0 });
    expect(group.editors).toEqual([b, c]);
    expect(group.activeEditor).toBe(c);
    await commands.executeCommand('workbench.action.closeOtherEditors', { groupId: group.id, editorIndex: 0 });
    expect(group.editors).toEqual([b]);
    expect(group.activeEditor).toBe(b);
    expect([a.isDisposed(), c.isDisposed()]).toEqual([true, true]);
  });

  test('a command run with the context of a group that is gone does nothing', async () => {
    const commands = instantiation.invokeFunction(accessor => accessor.get(ICommandService));
    const first = part.activeGroup;
    const [a, b] = await open(first, 'a', 'b');
    const second = part.addGroup(first, GroupDirection.RIGHT);
    const stale: IEditorCommandsContext = { groupId: second.id, editorIndex: 0 };
    part.removeGroup(second);
    await commands.executeCommand('workbench.action.closeActiveEditor', stale);
    await commands.executeCommand('workbench.action.closeEditorsInGroup', stale);
    expect(first.editors).toEqual([a, b]);
  });
});


describe('tabs', () => {
  const tabs = (group: IEditorGroup) => [...group.element.querySelectorAll<HTMLElement>('[role="tab"]')];
  const tab = (group: IEditorGroup, name: string) => tabs(group).find(element => element.textContent === name)!;
  const closeButton = (group: IEditorGroup, name: string) =>
    group.element.querySelector<HTMLButtonElement>(`button[aria-label="Close ${name}"]`)!;

  test('draw the model: one tab per editor in order, the active one selected, from changes made anywhere', async () => {
    const group = part.activeGroup;
    const [a, b, c] = await open(group, 'a', 'b', 'c');
    expect(group.element.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs(group).map(element => element.textContent)).toEqual(['a', 'b', 'c']);
    expect(tabs(group).map(element => element.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);

    // A move made straight through the group, not through the strip.
    group.moveEditor(a, group, { index: 2 });
    expect(tabs(group).map(element => element.textContent)).toEqual(['b', 'c', 'a']);
    expect(group.editors).toEqual([b, c, a]);
    expect(tab(group, 'a').getAttribute('aria-selected')).toBe('true');
    void c;
  });

  test('a click activates, the close button and the middle button close without activating', async () => {
    const group = part.activeGroup;
    const [a, b, c] = await open(group, 'a', 'b', 'c');
    tab(group, 'a').click();
    expect(group.activeEditor).toBe(a);

    closeButton(group, 'b').click();
    expect(group.editors).toEqual([a, c]);
    expect(group.activeEditor).toBe(a);

    tab(group, 'c').parentElement!.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    expect(group.editors).toEqual([a]);
    expect(group.activeEditor).toBe(a);
    expect([b.isDisposed(), c.isDisposed()]).toEqual([true, true]);
  });

  test('the arrows, Home and End reach the other tabs and keep focus in the strip', async () => {
    const group = part.activeGroup;
    const [a, b, c] = await open(group, 'a', 'b', 'c');
    const press = (name: string, key: string) =>
      tab(group, name).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    tab(group, 'c').focus();

    press('c', 'ArrowLeft');
    expect(group.activeEditor).toBe(b);
    expect(document.activeElement).toBe(tab(group, 'b'));
    expect(tab(group, 'b').tabIndex).toBe(0);
    press('b', 'Home');
    expect(group.activeEditor).toBe(a);
    press('a', 'End');
    expect(group.activeEditor).toBe(c);
    press('c', 'ArrowRight');
    expect(group.activeEditor).toBe(c);
    expect(document.activeElement).toBe(tab(group, 'c'));
  });

  test('a dirty editor shows on its tab', async () => {
    class DirtyInput extends TestInput {
      dirty = false;
      override isDirty(): boolean { return this.dirty; }
      setDirty(dirty: boolean): void { this.dirty = dirty; this._onDidChangeDirty.fire(); }
    }
    const group = part.activeGroup;
    const input = new DirtyInput('d');
    await group.openEditor(input);
    expect(tab(group, 'd').getAttribute('aria-description')).toBeNull();
    input.setDirty(true);
    expect(tab(group, 'd').getAttribute('aria-description')).toBe('Modified');
    input.setDirty(false);
    expect(tab(group, 'd').getAttribute('aria-description')).toBeNull();
  });

  test('the context menu runs its commands on the tab it opened on, and the title has the split button', async () => {
    const group = part.activeGroup;
    const [a, b, c] = await open(group, 'a', 'b', 'c');
    expect(group.element.querySelector('[role="toolbar"] button[aria-label="Split Editor Right"]')).not.toBeNull();

    tab(group, 'b').parentElement!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    const menu = document.querySelector('[role="menu"]')!;
    // Each row reads its label, then its key binding.
    const labels = [...menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent);
    expect(labels).toEqual(['CloseCtrl+W', 'Close Others', 'Close AllCtrl+K W', 'Split Up', 'Split Down', 'Split Left', 'Split Right']);
    const closeOthers = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith('Close Others'))!;
    closeOthers.click();
    await new Promise(resolve => setTimeout(resolve));
    expect(group.editors).toEqual([b]);
    expect(group.activeEditor).toBe(b);
    expect([a.isDisposed(), c.isDisposed()]).toEqual([true, true]);
  });
});

test('editor commands bind Cmd on macOS and Ctrl elsewhere, as VS Code declares them', () => {
  const rules = KeybindingsRegistry.getDefaultKeybindings();
  const label = (id: string, platform: 'mac' | 'linux' | 'win') =>
    formatKeybinding(new KeybindingResolver(rules, platform).lookupKeybinding(id)!, platform);
  expect([label('workbench.action.closeActiveEditor', 'mac'), label('workbench.action.closeActiveEditor', 'linux')])
    .toEqual(['⌘W', 'Ctrl+W']);
  expect(label('workbench.action.closeActiveEditor', 'win')).toBe('Ctrl+F4');
  expect([label('workbench.action.splitEditor', 'mac'), label('workbench.action.splitEditor', 'linux')]).toEqual(['⌘\\', 'Ctrl+\\']);
  expect([label('workbench.action.files.newUntitledFile', 'mac'), label('workbench.action.files.newUntitledFile', 'linux')])
    .toEqual(['⌥⌘N', 'Ctrl+Alt+N']);
  expect(label('workbench.action.closeEditorsInGroup', 'linux')).toBe('Ctrl+K W');
});
