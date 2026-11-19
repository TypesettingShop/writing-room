import { $, addDisposableListener, append, Dimension } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import type { IViewSize } from '../../../../base/browser/ui/grid/grid.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorsOrder, GroupModelChangeKind } from '../../../common/editor.js';
import type { GroupIdentifier } from '../../../common/editor.js';
import { EditorGroupEditorsCountContext } from '../../../common/contextkeys.js';
import { EditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import type { EditorInputWriter, IGroupModelChangeEvent, ISerializedEditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import { ConfirmResult } from '../../../common/editor/editorInput.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import type {
  ICloseEditorsFilter, IEditorGroup, IEditorMoveOptions, IEditorOpenOptions,
} from '../../../services/editor/common/editorGroupsService.js';
import type { IEditorPaneRegistry } from '../../editor.js';
import { DEFAULT_EDITOR_MAX_DIMENSIONS, DEFAULT_EDITOR_MIN_DIMENSIONS } from './editor.js';
import type { IEditorGroupsView, IEditorGroupView } from './editor.js';
import type { EditorPane } from './editorPane.js';
import { MultiEditorTabsControl } from './multiEditorTabsControl.js';
import './media/editorgroupview.css';

interface IPaneEntry {
  readonly pane: EditorPane;
  readonly container: HTMLElement;
}

/**
 * One editor group: the tab strip over the pane that shows the active editor. The model is the
 * truth; this view changes it, then shows what it says. The group keeps one pane per pane type and
 * reuses it for every input of that type, so everything that belongs to one editor lives in the
 * input, its model and its view state — never in a pane.
 */
export class EditorGroupView extends Disposable implements IEditorGroupView {
  readonly element: HTMLElement;
  readonly scopedContextKeyService: IContextKeyService;

  readonly minimumWidth = DEFAULT_EDITOR_MIN_DIMENSIONS.width;
  readonly maximumWidth = DEFAULT_EDITOR_MAX_DIMENSIONS.width;
  readonly minimumHeight = DEFAULT_EDITOR_MIN_DIMENSIONS.height;
  readonly maximumHeight = DEFAULT_EDITOR_MAX_DIMENSIONS.height;
  readonly onDidChange: Event<IViewSize | undefined> = Event.None;

  private readonly _onDidActiveEditorChange = this._register(new Emitter<void>());
  readonly onDidActiveEditorChange = this._onDidActiveEditorChange.event;

  private readonly _onWillDispose = this._register(new Emitter<void>());
  readonly onWillDispose = this._onWillDispose.event;

  private readonly model: EditorGroupModel;
  readonly titleContainer: HTMLElement;
  private readonly editorContainer: HTMLElement;
  private readonly tabsControl: MultiEditorTabsControl;
  private readonly panes = new Map<string, IPaneEntry>();
  private activePaneEntry: IPaneEntry | undefined;
  private dimension: Dimension | undefined;
  private readonly editorsCount: IContextKey<number>;
  private _disposed = false;
  /** The open close questions, by editor; a second close of one waits for the same answer. */
  private readonly pendingConfirmations = new Map<EditorInput, Promise<boolean>>();
  /** Set while `openEditor` changes the model: it shows the editor itself, with its options. */
  private opening = false;

  constructor(
    private readonly groupsView: IEditorGroupsView,
    restoredModel: EditorGroupModel | undefined,
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IContextKeyService contextKeyService: IContextKeyService,
  ) {
    super();
    this.model = this._register(restoredModel ?? new EditorGroupModel(() => this.groupsView.partOptions));

    this.element = $('.editor-group-container', { 'data-group-id': this.model.id, tabindex: -1 });
    this._register(toDisposable(() => this.element.remove()));
    this.scopedContextKeyService = this._register(contextKeyService.createScoped(this.element));
    this.editorsCount = EditorGroupEditorsCountContext.bindTo(this.scopedContextKeyService);
    this.updateContextKeys();

    this.titleContainer = append(this.element, $('.title'));
    this.titleContainer.style.height = `${this.titleHeight}px`;
    this.editorContainer = append(this.element, $('.editor-container'));
    this.tabsControl = this._register(instantiationService.createInstance(MultiEditorTabsControl, this.titleContainer, this.groupsView, this));

    // Whatever is clicked or focused inside a group makes it the active group, before a toolbar
    // button or a tab acts on "the active group".
    this._register(addDisposableListener(this.element, 'mousedown', () => this.groupsView.activateGroup(this), true));
    this._register(addDisposableListener(this.element, 'focusin', () => this.groupsView.activateGroup(this)));

    this._register(this.model.onDidModelChange(event => this.handleModelChange(event)));
  }

  get id(): GroupIdentifier {
    return this.model.id;
  }

  get titleHeight(): number {
    return MultiEditorTabsControl.EDITOR_TAB_HEIGHT.normal;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  get onDidModelChange(): Event<IGroupModelChangeEvent> {
    return this.model.onDidModelChange;
  }

  get count(): number {
    return this.model.count;
  }

  get isEmpty(): boolean {
    return this.model.count === 0;
  }

  get activeEditor(): EditorInput | null {
    return this.model.activeEditor;
  }

  get activeEditorPane(): EditorPane | undefined {
    return this.activePaneEntry?.pane;
  }

  get editors(): readonly EditorInput[] {
    return this.model.getEditors(EditorsOrder.SEQUENTIAL);
  }

  getEditors(order: EditorsOrder): readonly EditorInput[] {
    return this.model.getEditors(order);
  }

  getEditorByIndex(index: number): EditorInput | undefined {
    return this.model.getEditorByIndex(index);
  }

  getIndexOfEditor(editor: EditorInput): number {
    return this.model.indexOf(editor);
  }

  contains(editor: EditorInput, options?: { readonly matches?: boolean }): boolean {
    return options?.matches ? this.model.findEditor(editor) !== undefined : this.model.contains(editor);
  }

  isActive(editor: EditorInput): boolean {
    return this.model.isActive(editor);
  }

  setActive(active: boolean): void {
    this.element.classList.toggle('active', active);
  }

  // --- open, move, close

  openEditor(editor: EditorInput, options: IEditorOpenOptions = {}): Promise<EditorPane | undefined> {
    // Everything up to showing the pane happens now, so the group holds the editor once this returns.
    const previous = this.model.activeEditor;
    let opened: EditorInput;
    this.opening = true;
    try {
      opened = this.model.openEditor(editor, { index: options.index, active: !options.inactive }).editor;
    } finally {
      this.opening = false;
    }
    if (!this.model.isActive(opened)) {
      return Promise.resolve(undefined);
    }
    const shown = this.doShowEditor(opened, options);
    // As in VS Code, the group activates after its pane took the editor on (synchronously), so the
    // part's listeners see the pane that shows the active editor. An editor that opens with
    // `preserveFocus` does not make its group active.
    if (!options.preserveFocus) {
      this.groupsView.activateGroup(this);
    }
    if (previous !== opened) {
      this._onDidActiveEditorChange.fire();
    }
    return shown;
  }

  moveEditor(editor: EditorInput, target: IEditorGroup, options: IEditorMoveOptions = {}): boolean {
    const found = this.model.findEditor(editor);
    if (!found) {
      return false;
    }
    const [existing] = found;
    if (target === this) {
      if (options.index !== undefined) {
        this.model.moveEditor(existing, options.index);
      }
      if (!options.inactive) {
        void this.openEditor(existing, { preserveFocus: options.preserveFocus });
      }
      return true;
    }
    // The target opens it first, so no group lets go of an editor that is still open somewhere.
    void target.openEditor(existing, { ...options, viewState: this.getViewState(existing) });
    // Focus follows the moved editor unless the move preserves it. A pane that loads takes focus
    // only once it has, so hand it to the target group now: left in this group, the editor that
    // becomes active here would take it back when it loads, and this group with it.
    const document = this.element.ownerDocument;
    if (!options.preserveFocus && this.element.contains(document.activeElement) && !target.element.contains(document.activeElement)) {
      target.element.focus({ preventScroll: true });
    }
    this.doCloseEditor(existing);
    return true;
  }

  copyEditor(editor: EditorInput, target: IEditorGroup, options: IEditorMoveOptions = {}): void {
    const existing = this.model.findEditor(editor)?.[0];
    if (existing && target !== this) {
      void target.openEditor(existing, { ...options, viewState: this.getViewState(existing) });
    }
  }

  closeEditor(editor: EditorInput | undefined = this.activeEditor ?? undefined): Promise<boolean> {
    return editor ? this.closeEditors([editor]) : Promise.resolve(false);
  }

  closeEditors(editors: readonly EditorInput[] | ICloseEditorsFilter): Promise<boolean> {
    const requested = Array.isArray(editors)
      ? editors as readonly EditorInput[]
      : this.editors.filter(editor => editor !== (editors as ICloseEditorsFilter).except);
    // The editors as this group holds them: a request may name an input that only matches one.
    const held = [...new Set(requested.flatMap(editor => this.model.findEditor(editor)?.[0] ?? []))];
    const asking = held.filter(editor => this.shouldConfirmClose(editor));
    if (asking.length === 0) {
      // Nothing to ask: the editors are gone before this returns, as a close always was.
      return Promise.resolve(this.doCloseEditors(held));
    }
    return this.closeEditorsAfterConfirm(held, asking);
  }

  closeAllEditors(): Promise<boolean> {
    return this.closeEditors(this.editors);
  }

  /** Whether closing `editor` here needs its close handler's answer: it wants to ask, and no other group shows it. */
  private shouldConfirmClose(editor: EditorInput): boolean {
    if (!editor.closeHandler?.showConfirm()) {
      return false;
    }
    return !this.groupsView.groups.some(group => group !== this && !group.disposed && group.contains(editor, { matches: true }));
  }

  private async closeEditorsAfterConfirm(held: readonly EditorInput[], asking: readonly EditorInput[]): Promise<boolean> {
    for (const editor of asking) {
      if (!await this.confirmClose(editor)) {
        return false;
      }
    }
    // The answers took time: the group may be gone, and editors may have closed or moved meanwhile.
    if (this._disposed) {
      return false;
    }
    const remaining = held.filter(editor => this.model.contains(editor));
    return this.doCloseEditors(remaining) || remaining.length < held.length;
  }

  /**
   * Asks `editor`'s close handler, once: a close of the same editor that comes while the question is
   * open shares its answer. `true` lets the close go on.
   */
  private confirmClose(editor: EditorInput): Promise<boolean> {
    let pending = this.pendingConfirmations.get(editor);
    if (!pending) {
      pending = this.doConfirmClose(editor).finally(() => this.pendingConfirmations.delete(editor));
      this.pendingConfirmations.set(editor, pending);
    }
    return pending;
  }

  private async doConfirmClose(editor: EditorInput): Promise<boolean> {
    try {
      switch (await editor.closeHandler!.confirm([{ groupId: this.id, editor }])) {
        case ConfirmResult.SAVE:
          // A save that fails or is cancelled keeps the editor open; the input told the user why.
          return !editor.isDisposed() && await editor.save(this.id, { reason: 'explicit' }) !== undefined;
        case ConfirmResult.DONT_SAVE:
          if (!editor.isDisposed()) {
            await editor.revert(this.id, { soft: true });
          }
          return true;
        default:
          return false;
      }
    } catch (error) {
      console.error(`Could not ask whether to close ${editor.getName()}.`, error);
      return false;
    }
  }

  /** Closes the editors without asking. */
  private doCloseEditors(editors: readonly EditorInput[]): boolean {
    // The active editor goes last, so the pane does not show each editor that is about to close.
    const ordered = [...editors].sort((a, b) => Number(this.model.isActive(a)) - Number(this.model.isActive(b)));
    let closed = false;
    for (const editor of ordered) {
      if (this._disposed) {
        break;
      }
      closed = this.doCloseEditor(editor) || closed;
    }
    return closed;
  }

  private doCloseEditor(editor: EditorInput): boolean {
    const document = this.element.ownerDocument;
    const hadFocus = this.element.contains(document.activeElement);
    const result = this.model.closeEditor(editor);
    if (!result) {
      return false;
    }
    // The pane already moved on with the model's active editor (`onDidModelChange`).
    this.disposeIfUnused(result.editor);

    if (this.model.count === 0 && this.groupsView.count > 1 && this.groupsView.partOptions.closeEmptyGroups) {
      this.groupsView.removeGroup(this, true);
      // Focus inside a group that goes away moves to the group that becomes active.
      if (hadFocus) {
        this.groupsView.activeGroup.focus();
      }
    } else if (hadFocus && !this.element.contains(document.activeElement)) {
      // The pane let go of what had focus: keep it in the group rather than lose it to the page.
      this.focus();
    }
    return true;
  }

  /** An input goes once the last group that holds it lets go of it. */
  private disposeIfUnused(editor: EditorInput): void {
    if (!editor.isDisposed() && !this.groupsView.groups.some(group => !group.disposed && group.contains(editor))) {
      editor.dispose();
    }
  }

  // --- the pane

  private handleModelChange(event: IGroupModelChangeEvent): void {
    switch (event.kind) {
      case GroupModelChangeKind.EDITOR_ACTIVE:
        this.onDidChangeActiveEditor();
        break;
      case GroupModelChangeKind.EDITOR_OPEN:
      case GroupModelChangeKind.EDITOR_CLOSE:
        this.updateContextKeys();
        break;
      case GroupModelChangeKind.EDITOR_WILL_DISPOSE:
        // An input disposed from elsewhere (its model went away) leaves its group.
        if (event.editor && this.model.contains(event.editor)) {
          this.doCloseEditor(event.editor);
        }
        break;
    }
  }

  /**
   * The model's active editor changed: show the new one, or nothing. `openEditor` shows its editor
   * itself, with its options; this catches every other change, such as a close.
   */
  private onDidChangeActiveEditor(): void {
    this.updateContextKeys();
    if (this.opening) {
      return;
    }
    const active = this.model.activeEditor;
    if (!active) {
      this.clearPane();
    } else if (this.activePaneEntry?.pane.input !== active) {
      const keepFocus = this.element.contains(this.element.ownerDocument.activeElement);
      void this.doShowEditor(active, { preserveFocus: !keepFocus });
    }
    this._onDidActiveEditorChange.fire();
  }

  private async doShowEditor(editor: EditorInput, options: IEditorOpenOptions): Promise<EditorPane | undefined> {
    const entry = this.getPane(editor);
    if (!entry) {
      this.clearPane();
      return undefined;
    }
    if (this.activePaneEntry !== entry) {
      this.clearPane();
      entry.container.hidden = false;
      this.activePaneEntry = entry;
      this.layoutPane();
    }
    // The pane gets what it shows the editor with, not where the group put it.
    const shown = entry.pane.setInput(editor, {
      preserveFocus: options.preserveFocus, viewState: options.viewState, selection: options.selection,
    } as IEditorOpenOptions);
    if (!options.preserveFocus) {
      entry.pane.focus();
    }
    await shown;
    return entry.pane;
  }

  private getPane(editor: EditorInput): IPaneEntry | undefined {
    const descriptor = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.getEditorPane(editor);
    if (!descriptor) {
      console.error(`No editor pane is registered for ${editor.typeId}.`);
      return undefined;
    }
    let entry = this.panes.get(descriptor.typeId);
    if (!entry) {
      const container = append(this.editorContainer, $('.editor-instance', { hidden: '' }));
      const pane = descriptor.instantiate(this.instantiationService);
      pane.create(container);
      entry = { pane, container };
      this.panes.set(descriptor.typeId, entry);
    }
    return entry;
  }

  private clearPane(): void {
    const entry = this.activePaneEntry;
    if (entry) {
      this.activePaneEntry = undefined;
      entry.pane.clearInput();
      entry.container.hidden = true;
    }
  }

  private getViewState(editor: EditorInput): object | undefined {
    for (const { pane } of this.panes.values()) {
      const state = pane.getViewState(editor);
      if (state) {
        return state;
      }
    }
    return undefined;
  }

  private updateContextKeys(): void {
    this.editorsCount.set(this.model.count);
  }

  // --- grid view

  layout(width: number, height: number, _top: number, _left: number): void {
    this.dimension = new Dimension(width, height);
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    this.tabsControl.layout(width);
    this.layoutPane();
  }

  /** Lays the pane out again at the group's size, as after its element moved in the document. */
  relayout(): void {
    this.layoutPane();
  }

  private layoutPane(): void {
    if (!this.dimension) {
      return;
    }
    const height = Math.max(0, this.dimension.height - this.titleHeight);
    this.editorContainer.style.width = `${this.dimension.width}px`;
    this.editorContainer.style.height = `${height}px`;
    this.activePaneEntry?.pane.layout(new Dimension(this.dimension.width, height));
  }

  focus(): void {
    if (this.activePaneEntry) {
      this.activePaneEntry.pane.focus();
    } else {
      this.element.focus({ preventScroll: true });
    }
  }

  restoreActiveEditor(): void {
    const editor = this.model.activeEditor;
    if (editor) {
      void this.doShowEditor(editor, { preserveFocus: true }).catch(error =>
        console.warn('Could not show restored editor.', { key: 'editorpart.state', groupId: this.id, error }));
    }
  }

  toJSON(writeEditor?: EditorInputWriter): ISerializedEditorGroupModel {
    return this.model.serialize(writeEditor);
  }

  override dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._onWillDispose.fire();
    this.clearPane();
    for (const { pane, container } of this.panes.values()) {
      pane.dispose();
      container.remove();
    }
    this.panes.clear();
    super.dispose();
  }
}
