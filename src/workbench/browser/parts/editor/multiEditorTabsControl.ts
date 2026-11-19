import { $, addDisposableListener, append, DragAndDropObserver } from '../../../../base/browser/dom.js';
import type { MenuAction, MenuGroup } from '../../../../base/browser/ui/menu/menu.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import type { MenuActionGroup } from '../../../../platform/actions/common/actions.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorsOrder, GroupModelChangeKind } from '../../../common/editor.js';
import type { IEditorCommandsContext } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import type { IGroupModelChangeEvent } from '../../../common/editor/editorGroupModel.js';
import { DraggedEditorGroupIdentifier, DraggedEditorIdentifier, EditorDragAndDropObserver } from '../../dnd.js';
import type { DraggedEditorItem } from '../../dnd.js';
import { mergeDroppedGroup } from './editor.js';
import type { IEditorGroupsView, IEditorGroupView } from './editor.js';
import './media/multieditortabscontrol.css';

interface ITab {
  readonly element: HTMLElement;
  readonly label: HTMLElement;
  readonly close: HTMLButtonElement;
  readonly disposables: DisposableStore;
}

/** Runs each action of `groups` with `context` as its argument, as a tab's context menu does. */
function withContext(groups: readonly MenuActionGroup[] | readonly MenuGroup[], context: unknown): MenuGroup[] {
  const wrap = (action: MenuAction): MenuAction => action.groups
    ? { ...pick(action), groups: withContext(action.groups, context) }
    : { ...pick(action), run: () => (action.run as (...args: unknown[]) => unknown)?.(context) };
  return groups.map(([group, actions]) => [group, actions.map(wrap)] as const);
}

function pick({ id, label, enabled, checked, icon, keybinding }: MenuAction): MenuAction {
  return { id, label, enabled, checked, icon, keybinding };
}

/**
 * The index a dragged tab gets in the target group's model (`moveEditor`'s `index`, counted after
 * the move) when dropped on the left (`after` false) or right half of the tab at `hoveredIndex`.
 * An editor the target group already holds at `sourceIndex` (`sameGroup`: its own tab, or the same
 * editor split into it) leaves its old place first, so moving right it lands one lower to end up
 * where the marker showed; an editor new to the group leaves nothing behind in it.
 */
export function getTabDropIndex(sourceIndex: number, hoveredIndex: number, after: boolean, sameGroup: boolean): number {
  const slot = hoveredIndex + (after ? 1 : 0);
  return sameGroup && sourceIndex < slot ? slot - 1 : slot;
}

/** Whether the pointer at `clientX` is over the right half of a tab spanning `left` to `left + width`. */
export function isAfterTabMiddle(clientX: number, left: number, width: number): boolean {
  return clientX - left > width / 2;
}

const DROP_POSITION = 'data-tab-drop-position';

/**
 * The tab strip of one group, and its title toolbar. It draws from the group's model events alone,
 * never from the caller of a change, so a change made anywhere — a command, a drop, a restore —
 * shows the same way. It has no state of its own beyond the tab elements.
 */
export class MultiEditorTabsControl extends Disposable {
  static readonly EDITOR_TAB_HEIGHT = { normal: 35 } as const;

  private readonly tabsContainer: HTMLElement;
  private readonly tabs = new Map<EditorInput, ITab>();
  private width = 0;

  /** The tab or strip that shows the insertion marker. */
  private marked: HTMLElement | undefined;

  constructor(
    parent: HTMLElement,
    private readonly groupsView: IEditorGroupsView,
    private readonly group: IEditorGroupView,
    @IContextMenuService private readonly contextMenuService: IContextMenuService,
    @IMenuService private readonly menuService: IMenuService,
    @IInstantiationService instantiationService: IInstantiationService,
  ) {
    super();
    const container = append(parent, $('.tabs-and-actions-container'));
    this.tabsContainer = append(container, $('.tabs-container', { role: 'tablist', 'aria-label': 'Open Editors' }));
    this._register(toDisposable(() => container.remove()));
    // The strip scrolls sideways under the wheel too, as VS Code's does.
    this._register(addDisposableListener(this.tabsContainer, 'wheel', (event: WheelEvent) => {
      if (event.deltaY !== 0 && event.deltaX === 0) {
        // Firefox reports a mouse wheel in lines (`deltaMode` 1), not pixels; a page is the strip's width.
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.tabsContainer.clientWidth : 1;
        this.tabsContainer.scrollLeft += event.deltaY * unit;
        event.preventDefault();
      }
    }, { passive: false }));

    this.registerDragAndDrop();

    const actions = append(container, $('.editor-actions'));
    this._register(instantiationService.createInstance(
      MenuWorkbenchToolBar, actions, MenuId.EditorTitle, group.scopedContextKeyService,
    ));

    this._register(group.onDidModelChange(event => this.onDidModelChange(event)));
    this.redraw();
  }

  private registerDragAndDrop(): void {
    const observer = EditorDragAndDropObserver.INSTANCE;
    // The strip's empty part drags the whole group; a tab inside it is its own drag source.
    this.tabsContainer.draggable = true;
    this._register(addDisposableListener(this.tabsContainer, 'dragstart', (event: DragEvent) => {
      if (event.target === this.tabsContainer) {
        const label = this.group.activeEditor?.getName() ?? 'Editor Group';
        observer.startDrag(event, this.tabsContainer, new DraggedEditorGroupIdentifier(this.group.id), label);
      }
    }));

    const onDragOver = (event: DragEvent) => {
      const item = observer.getDraggedItem(event, this.tabsContainer);
      const drop = item && this.isDropOffered(item) ? this.getDropTarget(event) : undefined;
      if (!drop) {
        this.updateDropFeedback(undefined);
        return;
      }
      event.preventDefault();
      event.dataTransfer!.dropEffect = 'move';
      this.updateDropFeedback(drop);
    };
    // The browser takes a `dragenter`'s answer as the drop operation until the next `dragover`, so
    // entering each tab is answered too, not only entering the strip.
    this._register(addDisposableListener(this.tabsContainer, 'dragenter', onDragOver));
    const dnd = this._register(new DragAndDropObserver(this.tabsContainer, {
      onDragOver,
      onDragLeave: () => this.updateDropFeedback(undefined),
      onDrop: event => {
        const item = observer.getDraggedItem(event, this.tabsContainer);
        const drop = item && this.isDropOffered(item) ? this.getDropTarget(event) : undefined;
        this.updateDropFeedback(undefined);
        if (!item || !drop) {
          return;
        }
        event.preventDefault();
        // The dragged tab may leave the document now, and with it the `dragend` it would fire.
        observer.endDrag();
        this.onDrop(item, drop.hoveredIndex, drop.after);
      },
    }));
    this._register(observer.onDidEndDrag(() => {
      dnd.reset();
      this.updateDropFeedback(undefined);
    }));
  }

  private isDropOffered(item: DraggedEditorItem): boolean {
    if (item instanceof DraggedEditorGroupIdentifier) {
      return item.identifier !== this.group.id && !!this.groupsView.getGroup(item.identifier);
    }
    return !!this.groupsView.getGroup(item.identifier.groupId)?.contains(item.identifier.editor);
  }

  /** The tab under the pointer and its half, or the slot after the last tab over the empty strip. */
  private getDropTarget(event: DragEvent): { hoveredIndex: number; after: boolean; element: HTMLElement } {
    for (const [editor, tab] of this.tabs) {
      if (tab.element.contains(event.target as Node)) {
        const bounds = tab.element.getBoundingClientRect();
        return { hoveredIndex: this.group.getIndexOfEditor(editor), after: isAfterTabMiddle(event.clientX, bounds.left, bounds.width), element: tab.element };
      }
    }
    return { hoveredIndex: this.group.count - 1, after: true, element: this.tabsContainer };
  }

  private updateDropFeedback(drop: { after: boolean; element: HTMLElement } | undefined): void {
    const position = !drop ? undefined : drop.element === this.tabsContainer ? 'end' : drop.after ? 'after' : 'before';
    if (this.marked && this.marked !== drop?.element) {
      this.marked.removeAttribute(DROP_POSITION);
      this.marked = undefined;
    }
    if (drop && position) {
      drop.element.setAttribute(DROP_POSITION, position);
      this.marked = drop.element;
    }
  }

  private onDrop(item: DraggedEditorItem, hoveredIndex: number, after: boolean): void {
    if (item instanceof DraggedEditorIdentifier) {
      const { groupId, editor } = item.identifier;
      const source = this.groupsView.getGroup(groupId)!;
      // This group may hold the editor already: its own tab, or the same editor split here. The
      // move then shifts that tab, as `openEditor` finds it by `matches`.
      const held = this.group.editors.findIndex(candidate => candidate === editor || candidate.matches(editor));
      const index = getTabDropIndex(held, hoveredIndex, after, held !== -1);
      source.moveEditor(editor, this.group, { index });
    } else {
      // A whole group lands at the marker, its tabs in their order.
      mergeDroppedGroup(this.groupsView, this.groupsView.getGroup(item.identifier)!, this.group, hoveredIndex + (after ? 1 : 0));
    }
    this.groupsView.activateGroup(this.group);
    this.group.focus();
  }

  /** The strip is as wide as its group; the active tab is kept in view. */
  layout(width: number): void {
    this.width = width;
    this.revealActiveTab();
  }

  private onDidModelChange(event: IGroupModelChangeEvent): void {
    switch (event.kind) {
      case GroupModelChangeKind.EDITOR_OPEN:
      case GroupModelChangeKind.EDITOR_CLOSE:
      case GroupModelChangeKind.EDITOR_MOVE:
        this.redraw();
        break;
      case GroupModelChangeKind.EDITOR_ACTIVE:
        this.updateActive();
        break;
      case GroupModelChangeKind.EDITOR_LABEL:
      case GroupModelChangeKind.EDITOR_DIRTY:
        if (event.editor) {
          this.updateTab(event.editor);
        }
        break;
    }
  }

  /** Puts one tab per editor in tab order, keeping the elements of the editors that stay. */
  private redraw(): void {
    const editors = this.group.getEditors(EditorsOrder.SEQUENTIAL);
    const present = new Set(editors);
    for (const [editor, tab] of this.tabs) {
      if (!present.has(editor)) {
        tab.disposables.dispose();
        tab.element.remove();
        this.tabs.delete(editor);
      }
    }
    editors.forEach((editor, index) => {
      let tab = this.tabs.get(editor);
      if (!tab) {
        tab = this.createTab(editor);
        this.tabs.set(editor, tab);
        // A tab that stays is kept current by its editor's label and dirty events.
        this.updateTab(editor);
      }
      // Only move what is out of place, so a tab that keeps its place keeps its focus.
      if (this.tabsContainer.children[index] !== tab.element) {
        this.tabsContainer.insertBefore(tab.element, this.tabsContainer.children[index] ?? null);
      }
    });
    this.updateActive();
  }

  private createTab(editor: EditorInput): ITab {
    const disposables = new DisposableStore();
    // The tab role sits on the label, beside the close button rather than around it: a tab's
    // children are presentational, so a button inside it would not be one.
    const element = $('.tab', { role: 'none' });
    const label = append(element, $('.tab-label', { role: 'tab' }));
    const close = append(element, $('button.tab-close', { type: 'button', tabindex: -1 }) as HTMLButtonElement);
    element.draggable = true;
    disposables.add(addDisposableListener(element, 'dragstart', (event: DragEvent) => {
      // Read when the drag starts: the tab's group is the one that holds the editor now.
      const item = new DraggedEditorIdentifier({ groupId: this.group.id, editor });
      EditorDragAndDropObserver.INSTANCE.startDrag(event, element, item, editor.getName());
    }));

    const editorIndex = () => this.group.getIndexOfEditor(editor);
    const preventMiddleButtonDefault = (event: MouseEvent) => {
      // The press can start autoscroll. Releasing can paste the primary selection on Linux.
      // The tab still closes on auxclick.
      if (event.button === 1) {
        event.preventDefault();
      }
    };
    disposables.add(addDisposableListener(element, 'mousedown', preventMiddleButtonDefault));
    disposables.add(addDisposableListener(element, 'mouseup', preventMiddleButtonDefault));
    disposables.add(addDisposableListener(element, 'click', (event: MouseEvent) => {
      if (event.button === 0 && !close.contains(event.target as Node)) {
        void this.group.openEditor(editor);
      }
    }));
    disposables.add(addDisposableListener(element, 'auxclick', (event: MouseEvent) => {
      if (event.button === 1) {
        event.preventDefault();
        this.group.closeEditor(editor);
      }
    }));
    disposables.add(addDisposableListener(close, 'mousedown', (event: MouseEvent) => event.preventDefault()));
    disposables.add(addDisposableListener(close, 'click', (event: MouseEvent) => {
      event.stopPropagation();
      this.group.closeEditor(editor);
    }));
    disposables.add(addDisposableListener(label, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void this.group.openEditor(editor);
        return;
      }
      // Only the active tab is in the tab order, so the arrows, Home and End reach the others,
      // activating each without moving focus out of the strip, as in VS Code.
      const index = editorIndex();
      const targetIndex = event.key === 'Home' ? 0
        : event.key === 'End' ? this.group.count - 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? index - 1
            : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? index + 1
              : undefined;
      const target = targetIndex === undefined ? undefined : this.group.getEditorByIndex(targetIndex);
      if (target) {
        event.preventDefault();
        void this.group.openEditor(target, { preserveFocus: true });
        this.tabs.get(target)?.label.focus();
      }
    }));
    disposables.add(addDisposableListener(element, 'contextmenu', (event: MouseEvent) => {
      event.preventDefault();
      const context: IEditorCommandsContext = { groupId: this.group.id, editorIndex: editorIndex() };
      const actions = this.menuService.getMenuActions(MenuId.EditorTitleContext, this.group.scopedContextKeyService);
      this.contextMenuService.showContextMenu({
        getAnchor: () => ({ x: event.clientX, y: event.clientY }),
        getActions: () => withContext(actions, context),
      });
    }));
    return { element, label, close, disposables };
  }

  private updateTab(editor: EditorInput): void {
    const tab = this.tabs.get(editor);
    if (!tab) {
      return;
    }
    const name = editor.getName();
    const dirty = editor.isDirty();
    tab.label.textContent = name;
    tab.element.title = name;
    tab.element.classList.toggle('dirty', dirty);
    if (dirty) {
      tab.label.setAttribute('aria-description', 'Modified');
    } else {
      tab.label.removeAttribute('aria-description');
    }
    tab.close.setAttribute('aria-label', `Close ${name}`);
    tab.close.title = 'Close';
    tab.close.replaceChildren(renderIcon({ id: dirty ? 'circle-filled' : 'close' }) ?? (dirty ? '●' : '×'));
  }

  private updateActive(): void {
    const active = this.group.activeEditor;
    for (const [editor, tab] of this.tabs) {
      const selected = editor === active;
      tab.element.classList.toggle('active', selected);
      tab.label.setAttribute('aria-selected', String(selected));
      tab.label.tabIndex = selected ? 0 : -1;
    }
    this.revealActiveTab();
  }

  /** Scrolls the strip so the active tab is fully visible. */
  private revealActiveTab(): void {
    const active = this.group.activeEditor;
    const tab = active ? this.tabs.get(active)?.element : undefined;
    if (!tab) {
      return;
    }
    const visible = this.tabsContainer.clientWidth || this.width;
    // The container is positioned, so it is the offset parent of its tabs.
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < this.tabsContainer.scrollLeft) {
      this.tabsContainer.scrollLeft = left;
    } else if (right > this.tabsContainer.scrollLeft + visible) {
      this.tabsContainer.scrollLeft = right - visible;
    }
  }

  override dispose(): void {
    this.updateDropFeedback(undefined);
    for (const tab of this.tabs.values()) {
      tab.disposables.dispose();
    }
    this.tabs.clear();
    super.dispose();
  }
}
