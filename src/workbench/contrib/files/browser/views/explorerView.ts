import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { runMenuAction } from '../../../../../base/browser/ui/menu/menu.js';
import type { MenuAction, MenuAnchor, MenuGroup } from '../../../../../base/browser/ui/menu/menu.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IMenuService, MenuId, MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import type { MenuActionGroup } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ResourceContextKey } from '../../../../common/contextkeys.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { ExplorerItem } from '../../common/explorerModel.js';
import { IExplorerService } from '../explorerService.js';
import type { IExplorerEditable, IExplorerView } from '../explorerService.js';
import './media/explorerView.css';

/** VS Code's key: whether the Explorer item a menu is for is a folder. */
export const ExplorerFolderContext = new RawContextKey<boolean>('explorerResourceIsFolder', false);
/** Whether the Explorer item a menu is for is the workspace folder itself. */
export const ExplorerRootContext = new RawContextKey<boolean>('explorerResourceIsRoot', false);

/** VS Code's names for the tree and its inline input. */
export const EXPLORER_TREE_LABEL = 'Files Explorer';
export const EXPLORER_INPUT_LABEL = 'Type file name. Press Enter to confirm or Escape to cancel.';

type Row =
  | { readonly kind: 'item'; readonly item: ExplorerItem; readonly level: number }
  | { readonly kind: 'input'; readonly parent: ExplorerItem; readonly level: number; readonly isDirectory: boolean }
  | { readonly kind: 'more'; readonly parent: ExplorerItem; readonly level: number; readonly count: number };

function rowKey(row: Row): string {
  switch (row.kind) {
    case 'item': return row.item.resource.toString();
    case 'input': return 'input:' + row.parent.resource.toString();
    case 'more': return 'more:' + row.parent.resource.toString();
  }
}

/** The inline input of one edit: the row that holds it lives as long as the edit, through re-renders. */
class InlineInput extends Disposable {
  readonly row: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly message: HTMLElement;
  private finished = false;
  /** A re-render moves the row: its focus changes then are not the user's. */
  rendering = false;
  /** The input takes the focus the first time it is on screen. */
  needsFocus = true;

  constructor(document: Document, readonly editable: IExplorerEditable, private readonly onDone: (committed: boolean) => void) {
    super();
    this.row = document.createElement('div');
    this.row.className = 'explorer-row explorer-row-editing';
    this.row.setAttribute('role', 'treeitem');
    const twistie = document.createElement('span');
    twistie.className = 'explorer-twistie';
    twistie.setAttribute('aria-hidden', 'true');
    const box = document.createElement('div');
    box.className = 'explorer-input-box';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', EXPLORER_INPUT_LABEL);
    this.message = document.createElement('div');
    this.message.className = 'explorer-input-message';
    this.message.id = 'explorer-input-message-' + Math.random().toString(36).slice(2);
    this.message.hidden = true;
    box.append(this.input, this.message);
    this.row.append(twistie, box);

    if (editable.kind === 'rename') {
      this.input.value = editable.item.name;
    }
    this._register(addDisposableListener(this.input, 'input', () => this.validate()));
    this._register(addDisposableListener(this.input, 'keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        if (this.validate() === undefined) {
          this.finish(true);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.finish(false);
      }
    }));
    this._register(addDisposableListener(this.input, 'blur', () => {
      if (!this.rendering && !this.finished) {
        // Leaving the input takes a valid name, as in VS Code, and drops an invalid one.
        this.finish(this.validate() === undefined && this.input.value.length > 0);
      }
    }));
    this.validate();
  }

  /** Focuses the input; a rename selects the name without its extension, as VS Code does. */
  takeFocus(): void {
    this.needsFocus = false;
    this.input.focus();
    if (this.editable.kind === 'rename') {
      const name = this.input.value;
      const dot = this.editable.item.isDirectory ? -1 : name.lastIndexOf('.');
      this.input.setSelectionRange(0, dot > 0 ? dot : name.length);
    }
  }

  /** Shows why the name cannot be taken, if it cannot, and gives that reason. */
  validate(): string | undefined {
    const value = this.input.value;
    // An empty new name is not an error to show yet, only one that cannot be taken.
    const reason = this.editable.validate(value);
    const shown = value.length === 0 && this.editable.kind !== 'rename' ? undefined : reason;
    this.message.textContent = shown ?? '';
    this.message.hidden = shown === undefined;
    if (shown === undefined) {
      this.input.removeAttribute('aria-invalid');
      this.input.removeAttribute('aria-describedby');
    } else {
      this.input.setAttribute('aria-invalid', 'true');
      this.input.setAttribute('aria-describedby', this.message.id);
    }
    return reason;
  }

  private finish(committed: boolean): void {
    if (!this.finished) {
      this.finished = true;
      this.onDone(committed);
    }
  }
}

/**
 * The Explorer's file tree (VS Code's `ExplorerView` and its renderer): the workspace folder's
 * entries, folders first, with an inline input for new entries and renames, keyboard navigation in
 * the tree pattern, and the `explorer/context` menu.
 */
export class ExplorerView extends Disposable implements IExplorerView {
  private readonly element: HTMLElement;
  private readonly tree: HTMLElement;
  private rows: Row[] = [];
  private rowElements: HTMLElement[] = [];
  private readonly elementsByKey = new Map<string, HTMLElement>();
  /** The row with the roving tab stop when nothing is selected, by key. */
  private focusedKey: string | undefined;
  private readonly inlineInput = this._register(new MutableDisposable<InlineInput>());
  private renderScheduled = false;
  private pendingReveal: { item: ExplorerItem; focus: boolean } | undefined;
  /** An edit was cancelled from the keyboard: the tree takes the focus back once the input is gone. */
  private focusAfterRender = false;
  private disposed = false;

  constructor(
    parent: HTMLElement,
    @IExplorerService private readonly explorer: IExplorerService,
    @IEditorService private readonly editorService: IEditorService,
    @IContextKeyService private readonly contextKeyService: IContextKeyService,
    @IMenuService private readonly menuService: IMenuService,
    @IContextMenuService private readonly contextMenuService: IContextMenuService,
    @IModelService private readonly modelService: IModelService,
    @ILanguageService private readonly languageService: ILanguageService,
    @ICommandService private readonly commandService: ICommandService,
  ) {
    super();
    const document = parent.ownerDocument;
    this.element = document.createElement('div');
    this.element.className = 'explorer-folders-view';
    this.tree = document.createElement('div');
    this.tree.className = 'explorer-tree';
    this.tree.setAttribute('role', 'tree');
    this.tree.setAttribute('aria-label', EXPLORER_TREE_LABEL);
    this.element.append(this.tree);
    parent.append(this.element);
    this._register(toDisposable(() => {
      this.disposed = true;
      this.element.remove();
    }));

    this._register(explorer.registerView(this));
    this._register(explorer.onDidChange(() => this.scheduleRender()));
    this._register(explorer.onDidRequestReveal(({ item, focus }) => {
      this.pendingReveal = { item, focus };
      this.scheduleRender();
    }));
    this._register(addDisposableListener(this.tree, 'keydown', event => this.onKeyDown(event)));
    this._register(addDisposableListener(this.element, 'contextmenu', event => {
      if (event.target instanceof Node && this.inlineInput.value?.row.contains(event.target)) {
        return;
      }
      event.preventDefault();
      const row = this.rowOf(event.target);
      const item = row?.kind === 'item' ? row.item : row ? undefined : explorer.root;
      if (item) {
        if (!item.isRoot) {
          this.focusRow(this.rows.indexOf(row!));
        }
        this.showContextMenu(item, { x: event.clientX, y: event.clientY });
      }
    }));
    this.render();
  }

  layoutBody(height: number): void {
    this.element.style.height = `${height}px`;
  }

  focus(): void {
    const index = this.tabStopIndex();
    if (index >= 0) {
      this.rowElements[index].focus();
    } else {
      this.tree.focus();
    }
  }

  private scheduleRender(): void {
    if (!this.renderScheduled) {
      this.renderScheduled = true;
      queueMicrotask(() => {
        this.renderScheduled = false;
        if (!this.disposed) {
          this.render();
        }
      });
    }
  }

  private computeRows(): Row[] {
    const rows: Row[] = [];
    const editable = this.explorer.editable;
    const visit = (folder: ExplorerItem, level: number) => {
      const adding = editable && editable.kind !== 'rename' && editable.item === folder ? editable : undefined;
      const children = folder.visibleChildren;
      let inputAt = adding ? (adding.kind === 'newFolder' ? 0 : children.findIndex(child => !child.isDirectory)) : -1;
      if (adding && inputAt < 0) {
        inputAt = children.length;
      }
      children.forEach((child, index) => {
        if (index === inputAt) {
          rows.push({ kind: 'input', parent: folder, level, isDirectory: adding!.kind === 'newFolder' });
        }
        rows.push({ kind: 'item', item: child, level });
        if (child.isDirectory && this.explorer.isExpanded(child)) {
          visit(child, level + 1);
        }
      });
      if (adding && inputAt === children.length) {
        rows.push({ kind: 'input', parent: folder, level, isDirectory: adding.kind === 'newFolder' });
      }
      if (folder.hiddenChildCount) {
        rows.push({ kind: 'more', parent: folder, level, count: folder.hiddenChildCount });
      }
    };
    visit(this.explorer.root, 1);
    return rows;
  }

  private render(): void {
    this.syncInlineInput();
    const document = this.tree.ownerDocument;
    const input = this.inlineInput.value;
    const hadFocus = this.tree.contains(document.activeElement);
    const inputFocused = input !== undefined && document.activeElement === input.input;
    const selectionStart = input?.input.selectionStart ?? null;
    const selectionEnd = input?.input.selectionEnd ?? null;
    const focusedBefore = hadFocus && !inputFocused ? this.rows[this.rowElements.indexOf(document.activeElement as HTMLElement)] : undefined;
    if (focusedBefore) {
      this.focusedKey = rowKey(focusedBefore);
    }

    this.rows = this.computeRows();
    const selection = this.explorer.selection;
    const editing = input?.editable;
    this.rowElements = this.rows.map(row => {
      if (input && (row.kind === 'input' || (row.kind === 'item' && editing?.kind === 'rename' && editing.item === row.item))) {
        this.decorateRow(input.row, row, false);
        return input.row;
      }
      return this.renderRow(row, row.kind === 'item' && row.item === selection);
    });
    const shown = new Set(this.rows.map(rowKey));
    for (const key of [...this.elementsByKey.keys()]) {
      if (!shown.has(key)) {
        this.elementsByKey.delete(key);
      }
    }
    const tabStop = this.tabStopIndex();
    this.rowElements.forEach((element, index) => {
      element.tabIndex = index === tabStop ? 0 : -1;
    });
    this.tree.tabIndex = this.rowElements.length ? -1 : 0;

    // Rows are made anew, but the inline input's row stays attached so it keeps its focus and text.
    if (input) {
      input.rendering = true;
    }
    try {
      const keep = new Set(this.rowElements);
      for (const child of [...this.tree.children]) {
        if (!keep.has(child as HTMLElement)) {
          child.remove();
        }
      }
      let cursor = this.tree.firstElementChild;
      for (const element of this.rowElements) {
        if (cursor === element) {
          cursor = cursor.nextElementSibling;
        } else {
          this.tree.insertBefore(element, cursor);
        }
      }
      if (inputFocused && document.activeElement !== input.input && input.row.isConnected) {
        input.input.focus({ preventScroll: true });
        input.input.setSelectionRange(selectionStart, selectionEnd);
      }
    } finally {
      if (input) {
        input.rendering = false;
      }
    }
    if (input && !input.row.isConnected && this.explorer.editable === input.editable) {
      // The folder of the new entry, or the item being renamed, went away: so does the edit.
      this.focusAfterRender ||= inputFocused;
      this.explorer.setEditable(undefined);
    }

    const reveal = this.pendingReveal;
    this.pendingReveal = undefined;
    const revealIndex = reveal ? this.rows.findIndex(row => row.kind === 'item' && row.item === reveal.item) : -1;
    if (revealIndex >= 0) {
      this.rowElements[revealIndex].scrollIntoView?.({ block: 'nearest' });
    }
    if (this.focusAfterRender) {
      this.focusAfterRender = false;
      this.focus();
    } else if (input?.needsFocus && input.row.isConnected) {
      input.takeFocus();
    } else if (revealIndex >= 0 && reveal?.focus) {
      this.rowElements[revealIndex].focus();
    } else if (hadFocus && !inputFocused && !this.tree.contains(document.activeElement)) {
      this.focus();
    } else if (hadFocus && !inputFocused && tabStop >= 0 && document.activeElement !== this.rowElements[tabStop]
      && document.activeElement !== this.tree) {
      this.rowElements[tabStop].focus({ preventScroll: true });
    }
  }

  /** The index of the row that holds the tab stop: the selected one, else the one focused last, else the first. */
  private tabStopIndex(): number {
    if (!this.rows.length) {
      return -1;
    }
    const selection = this.explorer.selection;
    const selected = selection ? this.rows.findIndex(row => row.kind === 'item' && row.item === selection) : -1;
    if (selected >= 0) {
      return selected;
    }
    const focused = this.focusedKey ? this.rows.findIndex(row => rowKey(row) === this.focusedKey) : -1;
    return focused >= 0 ? focused : 0;
  }

  private syncInlineInput(): void {
    const editable = this.explorer.editable;
    if (this.inlineInput.value?.editable === editable) {
      return;
    }
    if (!editable) {
      this.inlineInput.clear();
      return;
    }
    const input = new InlineInput(this.tree.ownerDocument, editable, committed => {
      const value = input.input.value;
      const hadFocus = this.tree.ownerDocument.activeElement === input.input;
      if (this.explorer.editable === editable) {
        this.explorer.setEditable(undefined);
      }
      if (!committed && hadFocus) {
        // Back to the item being renamed, or to the folder the entry was for.
        if (editable.kind === 'rename' || !editable.item.isRoot) {
          this.explorer.setSelection(editable.item);
        }
        this.focusAfterRender = true;
      }
      editable.onFinish(value, committed);
    });
    this.inlineInput.value = input;
  }

  private decorateRow(element: HTMLElement, row: Row, selected: boolean): void {
    element.setAttribute('aria-level', String(row.level));
    element.style.paddingInlineStart = `${(row.level - 1) * 12 + 4}px`;
    element.setAttribute('aria-selected', String(selected));
  }

  /**
   * The element of `row`, made once per key and updated on each render: a row that is redrawn while
   * the mouse is pressed on it must stay the same element, or the click would not reach it.
   */
  private renderRow(row: Row, selected: boolean): HTMLElement {
    const key = rowKey(row);
    let element = this.elementsByKey.get(key);
    if (!element) {
      element = this.createRow();
      this.elementsByKey.set(key, element);
    }
    this.decorateRow(element, row, selected);
    const twistie = element.firstElementChild as HTMLElement;
    const label = element.lastElementChild as HTMLElement;
    twistie.className = 'explorer-twistie';
    element.classList.toggle('explorer-row-more', row.kind === 'more');
    if (row.kind === 'more') {
      element.setAttribute('aria-disabled', 'true');
      element.removeAttribute('aria-expanded');
      element.removeAttribute('title');
      label.textContent = row.count === 1 ? '1 more item is not shown' : `${row.count.toLocaleString('en-US')} more items are not shown`;
    } else if (row.kind === 'item') {
      const { item } = row;
      element.removeAttribute('aria-disabled');
      label.textContent = item.name;
      element.title = item.name;
      if (item.isDirectory) {
        const expanded = this.explorer.isExpanded(item);
        element.setAttribute('aria-expanded', String(expanded));
        twistie.classList.add('codicon', expanded ? 'codicon-chevron-down' : 'codicon-chevron-right');
      } else {
        element.removeAttribute('aria-expanded');
      }
    }
    return element;
  }

  private createRow(): HTMLElement {
    const document = this.tree.ownerDocument;
    const element = document.createElement('div');
    element.className = 'explorer-row';
    element.setAttribute('role', 'treeitem');
    const twistie = document.createElement('span');
    twistie.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'explorer-label';
    element.append(twistie, label);
    element.addEventListener('click', event => {
      const row = this.rows[this.rowElements.indexOf(element)];
      if (row?.kind === 'item') {
        event.preventDefault();
        this.focusRow(this.rowElements.indexOf(element));
        this.open(row.item, true);
      }
    });
    element.addEventListener('focus', () => {
      const index = this.rowElements.indexOf(element);
      const current = this.rows[index];
      if (!current) {
        return;
      }
      this.focusedKey = rowKey(current);
      for (const other of this.rowElements) {
        if (other !== element && other.tabIndex === 0) {
          other.tabIndex = -1;
        }
      }
      element.tabIndex = 0;
      if (current.kind === 'item' && this.explorer.selection !== current.item) {
        this.explorer.setSelection(current.item);
      }
    });
    return element;
  }

  private rowOf(target: EventTarget | null): Row | undefined {
    if (!(target instanceof Node)) {
      return undefined;
    }
    const index = this.rowElements.findIndex(element => element.contains(target));
    return index >= 0 ? this.rows[index] : undefined;
  }

  private focusRow(index: number): void {
    const element = this.rowElements[index];
    if (element) {
      element.focus();
      element.scrollIntoView?.({ block: 'nearest' });
    }
  }

  /** A file opens in the editor (keeping the focus here from a click); a folder expands or collapses. */
  private open(item: ExplorerItem, preserveFocus: boolean): void {
    if (item.isDirectory) {
      void this.explorer.setExpanded(item, !this.explorer.isExpanded(item));
      return;
    }
    this.explorer.setSelection(item);
    void this.editorService.openEditor({ resource: item.resource, options: { preserveFocus } }).catch(console.error);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.target instanceof Node && this.inlineInput.value?.row.contains(event.target)) {
      return;
    }
    const index = this.rowElements.findIndex(element => element === event.target);
    const row = this.rows[index];
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const item = row?.kind === 'item' ? row.item : row ? undefined : this.explorer.root;
      if (item) {
        this.showContextMenu(item, this.rowElements[index] ?? this.tree);
      }
      return;
    }
    if (!row || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const item = row.kind === 'item' ? row.item : undefined;
    switch (event.key) {
      case 'ArrowDown': this.focusRow(Math.min(this.rows.length - 1, index + 1)); break;
      case 'ArrowUp': this.focusRow(Math.max(0, index - 1)); break;
      case 'Home': this.focusRow(0); break;
      case 'End': this.focusRow(this.rows.length - 1); break;
      case 'ArrowRight':
        if (item?.isDirectory && !this.explorer.isExpanded(item)) {
          void this.explorer.setExpanded(item, true);
        } else if (item?.isDirectory && this.rows[index + 1]?.level === row.level + 1) {
          this.focusRow(index + 1);
        }
        break;
      case 'ArrowLeft':
        if (item?.isDirectory && this.explorer.isExpanded(item)) {
          void this.explorer.setExpanded(item, false);
        } else {
          const parent = row.kind === 'item' ? row.item.parent : row.kind === 'more' ? row.parent : undefined;
          const parentIndex = parent ? this.rows.findIndex(other => other.kind === 'item' && other.item === parent) : -1;
          if (parentIndex >= 0) {
            this.focusRow(parentIndex);
          }
        }
        break;
      case 'Enter':
        if (item) {
          this.open(item, false);
        }
        break;
      case ' ':
        if (item) {
          this.open(item, true);
        }
        break;
      case 'F2':
        if (item) {
          void this.runCommand('renameFile', item);
        }
        break;
      case 'Delete':
        if (item) {
          void this.runCommand('deleteFile', item);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private runCommand(id: string, item: ExplorerItem): Promise<void> {
    return runMenuAction({ id, label: id, run: () => this.commandService.executeCommand(id, item.resource) });
  }

  /**
   * The `explorer/context` menu of `item`: built-in and extension entries whose `when` holds for the
   * item's resource keys and `explorerResourceIsFolder`. Each runs with the item's URI.
   */
  private showContextMenu(item: ExplorerItem, anchor: MenuAnchor): void {
    const store = new DisposableStore();
    const context = store.add(this.contextKeyService.getScopedContextKeyService(this.tree).createScoped());
    store.add(new ResourceContextKey(context, this.modelService, this.languageService)).set(item.resource);
    ExplorerFolderContext.bindTo(context).set(item.isDirectory);
    ExplorerRootContext.bindTo(context).set(item.isRoot);
    const withResource = (groups: readonly MenuActionGroup[]): MenuGroup[] => groups.map(([group, actions]) => [
      group, actions.map((action): MenuAction => action instanceof MenuItemAction
        ? { ...action, run: () => action.run(item.resource) }
        : { ...action, groups: withResource(action.groups) }),
    ] as const);
    const groups = withResource(this.menuService.getMenuActions(MenuId.ExplorerContext, context));
    store.dispose();
    this.contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => groups });
  }
}
