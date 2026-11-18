import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Direction, isGridBranchNode, LayoutPriority, SerializableGrid, Sizing } from '../../../../base/browser/ui/grid/grid.js';
import type { GridNode, ISerializedGrid, IViewSize } from '../../../../base/browser/ui/grid/grid.js';
import { Emitter } from '../../../../base/common/event.js';
import type { Event } from '../../../../base/common/event.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ActiveEditorContext, ActiveEditorGroupEmptyContext, EditorsVisibleContext, MultipleEditorGroupsContext } from '../../../common/contextkeys.js';
import { EditorsOrder, GroupModelChangeKind } from '../../../common/editor.js';
import type { GroupIdentifier } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { deserializeEditorInput, EditorGroupModel, serializeEditorInput } from '../../../common/editor/editorGroupModel.js';
import { Memento } from '../../../common/memento.js';
import { GroupDirection, GroupLocation, GroupsOrder, MergeGroupMode } from '../../../services/editor/common/editorGroupsService.js';
import type {
  IEditorGroup, IEditorGroupsService, IFindGroupScope, IMergeGroupOptions,
} from '../../../services/editor/common/editorGroupsService.js';
import { Parts } from '../../../services/layout/browser/layoutService.js';
import { UNTITLED_TEXT_LIMIT } from '../../../services/untitled/common/untitledTextEditorHandler.js';
import { UntitledTextEditorInput } from '../../../services/untitled/common/untitledTextEditorInput.js';
import { Part } from '../../part.js';
import { getEditorPartOptions } from './editor.js';
import type { IEditorGroupsView, IEditorGroupView, IEditorPartOptions } from './editor.js';
import { createEditorDropTarget } from './editorDropTarget.js';
import { EditorGroupView } from './editorGroupView.js';

const EDITOR_PART_STATE_KEY = 'editorpart.state';

/** What `EditorPart.createState()` gives: everything the part needs to come back as it was. */
export interface IEditorPartUIState {
  readonly serializedGrid: ISerializedGrid;
  readonly activeGroup: GroupIdentifier;
  readonly mostRecentActiveGroups: GroupIdentifier[];
  /** Untitled inputs, most recently used first across all groups. */
  readonly mostRecentUntitledEditors?: string[];
}

/**
 * The editor part: a grid of editor groups. There is always at least one group. The part's limits
 * are its grid's, so two groups side by side need twice a group's minimum width.
 */
export class EditorPart extends Part implements IEditorGroupsService, IEditorGroupsView {
  declare readonly _serviceBrand: undefined;

  override minimumWidth = 0;
  override maximumWidth = Number.POSITIVE_INFINITY;
  override minimumHeight = 0;
  override maximumHeight = Number.POSITIVE_INFINITY;
  override readonly priority = LayoutPriority.High;

  private readonly _onDidChangeSize = this._register(new Emitter<IViewSize | undefined>());
  override readonly onDidChange: Event<IViewSize | undefined> = this._onDidChangeSize.event;

  private readonly _onDidChangeActiveGroup = this._register(new Emitter<IEditorGroup>());
  readonly onDidChangeActiveGroup = this._onDidChangeActiveGroup.event;
  private readonly _onDidAddGroup = this._register(new Emitter<IEditorGroup>());
  readonly onDidAddGroup = this._onDidAddGroup.event;
  private readonly _onDidRemoveGroup = this._register(new Emitter<IEditorGroup>());
  readonly onDidRemoveGroup = this._onDidRemoveGroup.event;
  private readonly _onDidMoveGroup = this._register(new Emitter<IEditorGroup>());
  readonly onDidMoveGroup = this._onDidMoveGroup.event;
  private readonly _onDidActiveEditorChange = this._register(new Emitter<void>());
  readonly onDidActiveEditorChange = this._onDidActiveEditorChange.event;

  private readonly groupViews = new Map<GroupIdentifier, EditorGroupView>();
  /** Group ids, the most recently active first. */
  private mostRecentActiveGroups: GroupIdentifier[] = [];
  private _activeGroup!: EditorGroupView;
  private gridWidget!: SerializableGrid<EditorGroupView>;
  private container!: HTMLElement;
  private restoredState = false;

  private readonly untitledListeners = new Map<UntitledTextEditorInput, IDisposable>();
  /** In insertion order, least recently active first. */
  private readonly recentUntitled = new Set<UntitledTextEditorInput>();
  private readonly beforeUnload = this._register(new MutableDisposable<IDisposable>());

  private readonly activeEditorKey: IContextKey<string | null>;
  private readonly editorIsOpenKey: IContextKey<boolean>;
  private readonly multipleGroupsKey: IContextKey<boolean>;
  private readonly activeGroupEmptyKey: IContextKey<boolean>;

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IStorageService private readonly storageService: IStorageService,
  ) {
    super(Parts.EDITOR_PART);
    // As in VS Code's main editor part, the part's scope is the workbench's own, so the keys hold
    // wherever focus is: the command palette opened from the sidebar sees them too.
    this.activeEditorKey = ActiveEditorContext.bindTo(contextKeyService);
    this.editorIsOpenKey = EditorsVisibleContext.bindTo(contextKeyService);
    this.multipleGroupsKey = MultipleEditorGroupsContext.bindTo(contextKeyService);
    this.activeGroupEmptyKey = ActiveEditorGroupEmptyContext.bindTo(contextKeyService);
  }

  get partOptions(): IEditorPartOptions {
    return getEditorPartOptions();
  }

  // --- groups

  get activeGroup(): EditorGroupView {
    return this._activeGroup;
  }

  get groups(): EditorGroupView[] {
    return this.getGroups(GroupsOrder.CREATION_TIME);
  }

  get count(): number {
    return this.groupViews.size;
  }

  getGroups(order: GroupsOrder = GroupsOrder.CREATION_TIME): EditorGroupView[] {
    switch (order) {
      case GroupsOrder.CREATION_TIME:
        return [...this.groupViews.values()].sort((a, b) => a.id - b.id);
      case GroupsOrder.MOST_RECENTLY_ACTIVE:
        return this.mostRecentActiveGroups.map(id => this.groupViews.get(id)!);
      case GroupsOrder.GRID_APPEARANCE: {
        const views: EditorGroupView[] = [];
        const visit = (node: GridNode<EditorGroupView>) => {
          if (isGridBranchNode(node)) {
            node.children.forEach(visit);
          } else {
            views.push(node.view);
          }
        };
        visit(this.gridWidget.getViews());
        return views;
      }
    }
  }

  getGroup(identifier: GroupIdentifier): EditorGroupView | undefined {
    return this.groupViews.get(identifier);
  }

  findGroup(scope: IFindGroupScope, source: IEditorGroup | GroupIdentifier = this._activeGroup, wrap?: boolean): EditorGroupView | undefined {
    const sourceView = this.assertGroupView(source);
    if (scope.direction !== undefined) {
      // Of the groups along that edge, the most recently active one, as in VS Code.
      const neighbours = this.gridWidget.getNeighborViews(sourceView, this.toGridViewDirection(scope.direction), wrap);
      const recency = (group: EditorGroupView) => this.mostRecentActiveGroups.indexOf(group.id);
      return neighbours.sort((a, b) => recency(a) - recency(b))[0];
    }
    const groups = this.getGroups(GroupsOrder.GRID_APPEARANCE);
    const index = groups.indexOf(sourceView);
    switch (scope.location) {
      case GroupLocation.FIRST: return groups[0];
      case GroupLocation.LAST: return groups[groups.length - 1];
      case GroupLocation.NEXT: return groups[index + 1] ?? (wrap ? groups[0] : undefined);
      case GroupLocation.PREVIOUS: return groups[index - 1] ?? (wrap ? groups[groups.length - 1] : undefined);
      default: return undefined;
    }
  }

  activateGroup(group: IEditorGroup | GroupIdentifier): EditorGroupView {
    const groupView = this.assertGroupView(group);
    this.doSetGroupActive(groupView);
    return groupView;
  }

  addGroup(location: IEditorGroup | GroupIdentifier, direction: GroupDirection): EditorGroupView {
    const locationView = this.assertGroupView(location);
    const groupView = this.doCreateGroupView();
    this.gridWidget.addView(groupView, this.getSplitSizing(), locationView, this.toGridViewDirection(direction));
    this.updateContextKeys();
    this._onDidAddGroup.fire(groupView);
    return groupView;
  }

  removeGroup(group: IEditorGroup | GroupIdentifier, preserveFocus?: boolean): void {
    const groupView = this.groupViews.get(typeof group === 'number' ? group : group.id);
    // The last group stays; a group that is already gone has nothing left to remove.
    if (!groupView || this.groupViews.size === 1) {
      return;
    }
    if (groupView.isEmpty) {
      this.doRemoveEmptyGroup(groupView, preserveFocus);
    } else {
      this.doRemoveGroupWithEditors(groupView);
    }
  }

  private doRemoveGroupWithEditors(groupView: EditorGroupView): void {
    // The editors go to the most recently active other group, which removes the emptied group.
    const target = this.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE).find(candidate => candidate !== groupView)!;
    this.mergeGroup(groupView, target);
  }

  private doRemoveEmptyGroup(groupView: EditorGroupView, preserveFocus?: boolean): void {
    const document = groupView.element.ownerDocument;
    const hadFocus = groupView.element.contains(document.activeElement);
    if (this._activeGroup === groupView) {
      // The most recently active other group takes over, as in VS Code.
      const next = this.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE).find(candidate => candidate !== groupView)!;
      this.doSetGroupActive(next);
    }
    this.gridWidget.removeView(groupView, this.getSplitSizing());
    this.groupViews.delete(groupView.id);
    this.mostRecentActiveGroups = this.mostRecentActiveGroups.filter(id => id !== groupView.id);
    groupView.dispose();
    if (hadFocus && !preserveFocus) {
      this._activeGroup.focus();
    }
    this.updateContextKeys();
    this._onDidRemoveGroup.fire(groupView);
  }

  moveGroup(group: IEditorGroup | GroupIdentifier, location: IEditorGroup | GroupIdentifier, direction: GroupDirection): EditorGroupView {
    const sourceView = this.assertGroupView(group);
    const targetView = this.assertGroupView(location);
    if (sourceView === targetView) {
      throw new Error('A group cannot be moved beside itself.');
    }
    // The grid moves the group's own element: its panes, editors and focus stay as they are.
    this.gridWidget.moveView(sourceView, this.getSplitSizing(), targetView, this.toGridViewDirection(direction));
    sourceView.relayout();
    this._onDidMoveGroup.fire(sourceView);
    return sourceView;
  }

  mergeGroup(group: IEditorGroup | GroupIdentifier, target: IEditorGroup | GroupIdentifier, options: IMergeGroupOptions = {}): boolean {
    const sourceView = this.assertGroupView(group);
    const targetView = this.assertGroupView(target);
    if (sourceView === targetView) {
      return false;
    }
    let index = options.index ?? targetView.count;
    const sourceWasActive = this._activeGroup === sourceView;
    // Read before the loop: each move hands the source's active editor on to the next one.
    const sourceActive = sourceView.activeEditor;
    for (const editor of sourceView.getEditors(EditorsOrder.SEQUENTIAL)) {
      // An editor the target already holds (split into it) moves there instead, leaving its old
      // place first: before `index`, it would land one past where the rest go.
      const held = targetView.editors.findIndex(candidate => candidate === editor || candidate.matches(editor));
      if (held !== -1 && held < index) {
        index--;
      }
      // Only the source's active editor, from the active group, becomes active in the target.
      const inactive = editor !== sourceActive || !sourceWasActive;
      const moveOptions = { index: index++, inactive, preserveFocus: inactive };
      if (options.mode === MergeGroupMode.COPY_EDITORS) {
        sourceView.copyEditor(editor, targetView, moveOptions);
      } else if (!sourceView.disposed) {
        sourceView.moveEditor(editor, targetView, moveOptions);
      }
    }
    // A merge always takes the emptied source away, whatever `closeEmptyGroups` says.
    if (!sourceView.disposed && sourceView.isEmpty) {
      this.removeGroup(sourceView, true);
    }
    return true;
  }

  mergeAllGroups(target: IEditorGroup | GroupIdentifier = this._activeGroup): boolean {
    const targetView = this.assertGroupView(target);
    for (const group of this.getGroups(GroupsOrder.GRID_APPEARANCE)) {
      if (group !== targetView && !group.disposed) {
        this.mergeGroup(group, targetView);
      }
    }
    return true;
  }

  createState(): IEditorPartUIState {
    const allowed = new Set<UntitledTextEditorInput>();
    let remaining = UNTITLED_TEXT_LIMIT;
    for (const editor of this.getRecentUntitledEditors()) {
      const length = editor.model.getValueLength();
      if (length <= remaining) {
        allowed.add(editor);
        remaining -= length;
      }
    }

    const written = new Set<UntitledTextEditorInput>();
    const serializedGrid = this.gridWidget.serialize(group => group.toJSON(editor => {
      if (!(editor instanceof UntitledTextEditorInput)) {
        return serializeEditorInput(editor);
      }
      if (!allowed.has(editor)) {
        return undefined;
      }
      if (written.has(editor)) {
        return editor.getName();
      }
      const value = serializeEditorInput(editor);
      if (typeof value === 'string') {
        written.add(editor);
      }
      return value;
    }));

    return {
      serializedGrid,
      activeGroup: this._activeGroup.id,
      mostRecentActiveGroups: [...this.mostRecentActiveGroups],
      mostRecentUntitledEditors: [...allowed].filter(editor => written.has(editor)).map(editor => editor.getName()),
    };
  }

  get hasStoredState(): boolean {
    return this.restoredState;
  }

  restoreActiveEditors(): void {
    for (const group of this.groupViews.values()) {
      group.restoreActiveEditor();
    }
    this.updateContextKeys();
  }

  // --- part

  protected override createContentArea(parent: HTMLElement): void {
    this.container = append(parent, $('.content'));
    type EditorPartMemento = Record<typeof EDITOR_PART_STATE_KEY, IEditorPartUIState>;
    // Capture the state before the memento's own onWillSaveState listener serializes it.
    this._register(this.storageService.onWillSaveState(() => {
      memento[EDITOR_PART_STATE_KEY] = this.createState();
    }));
    const state = this._register(new Memento<EditorPartMemento>(
      Parts.EDITOR_PART, this.storageService, { saveUnchanged: true },
    ));
    const memento = state.getMemento(StorageScope.WORKSPACE, StorageTarget.USER);
    this.restoredState = Object.hasOwn(memento, EDITOR_PART_STATE_KEY);

    const restored = this.restoredState ? this.doCreateGridControlWithPreviousState(memento[EDITOR_PART_STATE_KEY]) : undefined;
    if (restored) {
      this.gridWidget = this._register(restored.grid);
      this.doSetGroupActive(restored.activeGroup);
    } else {
      const initialGroup = this.doCreateGroupView();
      this.gridWidget = this._register(new SerializableGrid(initialGroup));
      this.doSetGroupActive(initialGroup);
    }
    this.container.append(this.gridWidget.element);
    this._register(this.gridWidget.onDidChange(() => this.updateLimits()));
    this.syncUntitledListeners();
    this.updateLimits();
    this.updateContextKeys();
    this.setupDragAndDropSupport();
  }

  private doCreateGridControlWithPreviousState(
    state: IEditorPartUIState | undefined,
  ): { grid: SerializableGrid<EditorGroupView>; activeGroup: EditorGroupView } | undefined {
    const warn = (detail: string, error?: unknown) =>
      console.warn('Could not fully restore editor part.', { key: EDITOR_PART_STATE_KEY, detail, error });
    const restoredInputs = new Set<EditorInput>();
    const inputCache = new Map<string, Map<string, EditorInput>>();
    const readEditor = (typeId: string, value: string) => {
      let byValue = inputCache.get(typeId);
      if (!byValue) {
        byValue = new Map();
        inputCache.set(typeId, byValue);
      }
      let input = byValue.get(value);
      if (!input) {
        input = deserializeEditorInput(this.instantiationService, typeId, value);
        if (input) {
          byValue.set(value, input);
          restoredInputs.add(input);
        }
      }
      return input;
    };

    let grid: SerializableGrid<EditorGroupView> | undefined;
    try {
      if (typeof state !== 'object' || state === null) {
        throw new Error('Invalid saved editor part state.');
      }
      grid = SerializableGrid.deserialize(state.serializedGrid, {
        fromJSON: data => {
          const model = EditorGroupModel.deserialize(data, readEditor, () => this.partOptions);
          try {
            if (this.groupViews.has(model.id)) {
              throw new Error('Duplicate saved editor group id.');
            }
            return this.doCreateGroupView(model);
          } catch (error) {
            model.dispose();
            throw error;
          }
        },
      });
      const groups = [...this.groupViews.values()];
      const recentGroups = new Set<EditorGroupView>();
      if (Array.isArray(state.mostRecentActiveGroups)) {
        for (const id of state.mostRecentActiveGroups) {
          const group = this.groupViews.get(id);
          if (group) {
            recentGroups.add(group);
          } else {
            warn('Unknown recently used editor group', id);
          }
        }
      } else {
        warn('Invalid recently used group list');
      }
      groups.forEach(group => recentGroups.add(group));
      let activeGroup = this.groupViews.get(state.activeGroup);
      if (!activeGroup) {
        warn('Unknown active editor group', state.activeGroup);
        activeGroup = recentGroups.values().next().value!;
      }
      const nonEmptyGroups = [...recentGroups].filter(group => !group.isEmpty);
      if (activeGroup.isEmpty && nonEmptyGroups.length > 0) {
        activeGroup = nonEmptyGroups[0];
      }
      for (const group of groups) {
        if (group !== activeGroup && group.isEmpty) {
          warn('Dropping empty editor group', group.id);
          grid.removeView(group);
          group.dispose();
          this.groupViews.delete(group.id);
          recentGroups.delete(group);
        } else if (!grid.isViewVisible(group)) {
          warn('Showing hidden editor group', group.id);
          grid.setViewVisible(group, true);
        }
      }
      this.mostRecentActiveGroups = [...recentGroups].map(group => group.id);
      const openEditors = new Set([...recentGroups].flatMap(group => [...group.editors]));
      for (const input of restoredInputs) {
        if (!openEditors.has(input)) {
          input.dispose();
        }
      }
      this.restoreUntitledRecency(state.mostRecentUntitledEditors, openEditors);
      return { grid, activeGroup };
    } catch (error) {
      warn('Ignoring saved grid', error);
      grid?.dispose();
      for (const group of this.groupViews.values()) {
        group.dispose();
      }
      this.groupViews.clear();
      this.mostRecentActiveGroups = [];
      for (const input of restoredInputs) {
        input.dispose();
      }
      return undefined;
    }
  }

  private restoreUntitledRecency(names: string[] | undefined, editors: ReadonlySet<EditorInput>): void {
    if (names === undefined) {
      return;
    }
    if (!Array.isArray(names)) {
      console.warn('Invalid recently used untitled editor list.', { key: EDITOR_PART_STATE_KEY });
      return;
    }
    const byName = new Map<string, UntitledTextEditorInput>();
    for (const editor of editors) {
      if (editor instanceof UntitledTextEditorInput) {
        byName.set(editor.getName(), editor);
      }
    }
    for (let index = names.length - 1; index >= 0; index--) {
      const editor = byName.get(names[index]);
      if (editor) {
        this.recentUntitled.add(editor);
      } else {
        console.warn('Recently used untitled editor is unavailable.', { key: EDITOR_PART_STATE_KEY, index });
      }
    }
  }

  private getRecentUntitledEditors(): Iterable<UntitledTextEditorInput> {
    const editors = new Set([...this.recentUntitled].reverse());
    // Editors opened in the background have no global activation yet.
    for (const group of this.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
      for (const editor of group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
        if (editor instanceof UntitledTextEditorInput) {
          editors.add(editor);
        }
      }
    }
    return editors;
  }

  private touchUntitledEditor(editor: EditorInput | null): void {
    if (editor instanceof UntitledTextEditorInput) {
      this.recentUntitled.delete(editor);
      this.recentUntitled.add(editor);
    }
  }

  private syncUntitledListeners(): void {
    const open = new Set(this.groups.flatMap(group => [...group.editors]).filter(
      editor => editor instanceof UntitledTextEditorInput,
    ));
    for (const [editor, listener] of this.untitledListeners) {
      if (!open.has(editor)) {
        listener.dispose();
        this.untitledListeners.delete(editor);
        this.recentUntitled.delete(editor);
      }
    }
    for (const editor of open) {
      if (!this.untitledListeners.has(editor)) {
        this.untitledListeners.set(editor, editor.model.onDidChangeContent(() => this.updateBeforeUnload()));
      }
    }
    this.updateBeforeUnload();
  }

  private updateBeforeUnload(): void {
    let remaining = UNTITLED_TEXT_LIMIT;
    for (const editor of this.untitledListeners.keys()) {
      remaining -= editor.model.getValueLength();
      if (remaining < 0) {
        const window = this.element.ownerDocument.defaultView!;
        this.beforeUnload.value ??= addDisposableListener(window, 'beforeunload', event => {
          event.preventDefault();
          event.returnValue = ' ';
        });
        return;
      }
    }
    this.beforeUnload.clear();
  }

  private setupDragAndDropSupport(): void {
    this._register(createEditorDropTarget(this.container, this));
  }

  override layout(width: number, height: number, top: number, left: number): void {
    super.layout(width, height, top, left);
    this.container.style.width = `${width}px`;
    this.container.style.height = `${height}px`;
    this.gridWidget.layout(width, height);
  }

  private updateLimits(): void {
    const limits = {
      minimumWidth: this.gridWidget.minimumWidth,
      maximumWidth: this.gridWidget.maximumWidth,
      minimumHeight: this.gridWidget.minimumHeight,
      maximumHeight: this.gridWidget.maximumHeight,
    };
    if (Object.entries(limits).some(([key, value]) => this[key as keyof typeof limits] !== value)) {
      Object.assign(this, limits);
      this._onDidChangeSize.fire(undefined);
    }
  }

  private doCreateGroupView(model?: EditorGroupModel): EditorGroupView {
    const groupView = this.instantiationService.createInstance(EditorGroupView, this, model);
    this.groupViews.set(groupView.id, groupView);
    this.mostRecentActiveGroups.push(groupView.id);
    groupView.onDidActiveEditorChange(() => {
      if (groupView === this._activeGroup) {
        this.touchUntitledEditor(groupView.activeEditor);
        this.updateContextKeys();
        this._onDidActiveEditorChange.fire();
      }
    });
    groupView.onDidModelChange(({ kind }) => {
      if (kind === GroupModelChangeKind.EDITOR_OPEN || kind === GroupModelChangeKind.EDITOR_CLOSE) {
        this.syncUntitledListeners();
      }
      this.updateContextKeys();
    });
    return groupView;
  }

  private doSetGroupActive(groupView: EditorGroupView): void {
    if (this._activeGroup === groupView) {
      return;
    }
    const previous = this._activeGroup;
    this._activeGroup = groupView;
    this.touchUntitledEditor(groupView.activeEditor);
    this.mostRecentActiveGroups = [groupView.id, ...this.mostRecentActiveGroups.filter(id => id !== groupView.id)];
    previous?.setActive(false);
    groupView.setActive(true);
    this.updateContextKeys();
    this._onDidChangeActiveGroup.fire(groupView);
    this._onDidActiveEditorChange.fire();
  }

  private updateContextKeys(): void {
    const groups = [...this.groupViews.values()];
    // VS Code's `activeEditor` is the id of the pane that shows the active editor.
    const active = this._activeGroup?.activeEditor ? this._activeGroup.activeEditorPane : undefined;
    this.activeEditorKey.set(active?.id ?? null);
    this.editorIsOpenKey.set(groups.some(group => !group.isEmpty));
    this.multipleGroupsKey.set(groups.length > 1);
    this.activeGroupEmptyKey.set(this._activeGroup?.isEmpty ?? true);
  }

  private getSplitSizing(): Sizing {
    switch (this.partOptions.splitSizing) {
      case 'distribute': return Sizing.Distribute;
      case 'split': return Sizing.Split;
      default: return Sizing.Auto;
    }
  }

  private toGridViewDirection(direction: GroupDirection): Direction {
    switch (direction) {
      case GroupDirection.UP: return Direction.Up;
      case GroupDirection.DOWN: return Direction.Down;
      case GroupDirection.LEFT: return Direction.Left;
      case GroupDirection.RIGHT: return Direction.Right;
    }
  }

  private assertGroupView(group: IEditorGroup | GroupIdentifier): EditorGroupView {
    const groupView = this.groupViews.get(typeof group === 'number' ? group : group.id);
    if (!groupView || (typeof group !== 'number' && groupView !== group)) {
      throw new Error(`Invalid editor group: ${typeof group === 'number' ? group : group.id}.`);
    }
    return groupView;
  }

  override dispose(): void {
    // Every input still open goes with the part, once, after the groups that show it.
    const editors = new Set<EditorInput>(this.getGroups().flatMap(group => [...group.editors]));
    for (const group of this.groupViews.values()) {
      group.dispose();
    }
    this.groupViews.clear();
    for (const listener of this.untitledListeners.values()) {
      listener.dispose();
    }
    this.untitledListeners.clear();
    this.recentUntitled.clear();
    super.dispose();
    for (const editor of editors) {
      editor.dispose();
    }
  }
}
