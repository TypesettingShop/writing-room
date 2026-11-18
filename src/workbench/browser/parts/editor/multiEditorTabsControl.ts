import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
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
import type { IEditorGroupView } from './editor.js';
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
 * The tab strip of one group, and its title toolbar. It draws from the group's model events alone,
 * never from the caller of a change, so a change made anywhere — a command, a drop, a restore —
 * shows the same way. It has no state of its own beyond the tab elements.
 */
export class MultiEditorTabsControl extends Disposable {
  static readonly EDITOR_TAB_HEIGHT = { normal: 35 } as const;

  private readonly tabsContainer: HTMLElement;
  private readonly tabs = new Map<EditorInput, ITab>();
  private width = 0;

  constructor(
    parent: HTMLElement,
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
        this.tabsContainer.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    }, { passive: false }));

    const actions = append(container, $('.editor-actions'));
    this._register(instantiationService.createInstance(
      MenuWorkbenchToolBar, actions, MenuId.EditorTitle, group.scopedContextKeyService,
    ));

    this._register(group.onDidModelChange(event => this.onDidModelChange(event)));
    this.redraw();
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
    for (const [editor, tab] of this.tabs) {
      if (!editors.includes(editor)) {
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
      }
      // Only move what is out of place, so a tab that keeps its place keeps its focus.
      if (this.tabsContainer.children[index] !== tab.element) {
        this.tabsContainer.insertBefore(tab.element, this.tabsContainer.children[index] ?? null);
      }
      this.updateTab(editor);
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

    const editorIndex = () => this.group.getIndexOfEditor(editor);
    disposables.add(addDisposableListener(element, 'mousedown', (event: MouseEvent) => {
      // The middle button would start autoscroll; closing happens on its click.
      if (event.button === 1) {
        event.preventDefault();
      }
    }));
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
    for (const tab of this.tabs.values()) {
      tab.disposables.dispose();
    }
    this.tabs.clear();
    super.dispose();
  }
}
