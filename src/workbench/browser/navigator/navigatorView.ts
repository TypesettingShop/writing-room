import { addDisposableListener } from '../../../base/browser/dom.js';
import type { MenuAnchor } from '../../../base/browser/ui/menu/menu.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { IMenuService, MenuId } from '../../../platform/actions/common/actions.js';
import type { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import type { IContextMenuService } from '../../../platform/contextview/browser/contextMenuService.js';
import type { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import {
  breadcrumb, moveKey, parentLine, revealOffset, twigParts, TWIG_TEXT, UP_KEY, windowRange, type NavigatorLine, type NavigatorNode,
} from '../../common/navigator/navigatorTree.js';
import type { NavigatorStore, NavigatorViewState, TitleEdit } from './navigatorViewState.js';
import { moveAdjacent, NAVIGATOR_ROW_HEIGHT as ROW_HEIGHT, NavigatorDrag, type NavigatorDragOptions } from './navigatorDrag.js';
import './media/navigator.css';

let nextTreeId = 0;

function icon(document: Document, name: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `codicon codicon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

interface RowIcon {
  readonly id: string;
  readonly label?: string;
}

interface MountedRow<N extends NavigatorNode> {
  readonly element: HTMLElement;
  readonly line: NavigatorLine<N>;
  readonly icon: RowIcon | undefined;
}

interface NavigatorViewOptions<N extends NavigatorNode> {
  readonly cssPrefix: string;
  readonly treeLabel: string;
  readonly rowIcon: (node: N, dir: boolean) => RowIcon;
  readonly keyboardMultiSelect?: boolean;
  readonly emptyHint?: string;
  readonly emptyActions?: readonly (readonly [kind: N['kind'], title: string])[];
  readonly renderEmpty?: (parent: HTMLElement) => IDisposable;
  readonly loadingMessage: string;
  readonly invalidTitle: string;
  readonly titleReloaded: string;
  readonly menuId: MenuId;
  readonly selectionKindKey: string;
  readonly setMenuContext?: (context: IContextKeyService, node: N | undefined) => void;
  readonly activate?: (node: N) => void;
  readonly drag?: NavigatorDragOptions;
}

export class NavigatorView<N extends NavigatorNode, S extends NavigatorStore<N>> extends Disposable {
  private readonly document: Document;
  private readonly location: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly tree: HTMLDivElement;
  private readonly rows: HTMLDivElement;
  private readonly drag: NavigatorDrag<N, S> | undefined;
  private readonly menu = this._register(new MutableDisposable());
  private editor: { edit: TitleEdit; input: HTMLInputElement; message: HTMLDivElement; element: HTMLDivElement } | undefined;
  private previousFolder: string | null | undefined;
  private previousCursor: string | null = null;
  private previousLines: readonly NavigatorLine<N>[] | undefined;
  private positions = new Map<string, number>();
  private readonly mountedRows = new Map<string, MountedRow<N>>();
  private lastStart = -1;
  private lastEnd = -1;

  constructor(
    parent: HTMLElement,
    private readonly state: NavigatorViewState<N, S>,
    private readonly options: NavigatorViewOptions<N>,
    private readonly contextKeys: IContextKeyService,
    private readonly menus: IMenuService,
    private readonly contextMenus: IContextMenuService,
    instantiation: IInstantiationService,
  ) {
    super();
    this.document = parent.ownerDocument;
    this.location = this.document.createElement('div');
    this.location.className = `${this.options.cssPrefix}-location`;

    this.status = this.document.createElement('div');
    this.status.className = `${this.options.cssPrefix}-notice`;
    this.status.setAttribute('role', 'status');

    this.empty = this.document.createElement('div');
    this.empty.className = `${this.options.cssPrefix}-empty`;
    if (options.renderEmpty) {
      this._register(options.renderEmpty(this.empty));
    } else {
      const hint = this.document.createElement('p');
      hint.textContent = options.emptyHint ?? '';
      this.empty.append(hint);
      for (const [kind, title] of options.emptyActions ?? []) {
        const button = this.document.createElement('button');
        button.type = 'button';
        button.textContent = title;
        this.empty.append(button);
        this._register(addDisposableListener(button, 'click', () => void this.state.create(kind)));
      }
    }

    this.tree = this.document.createElement('div');
    this.tree.id = `${options.cssPrefix}-navigator-${++nextTreeId}`;
    this.tree.className = `${this.options.cssPrefix}-tree`;
    this.tree.tabIndex = 0;
    this.tree.setAttribute('role', 'tree');
    this.tree.setAttribute('aria-label', options.treeLabel);
    this.tree.setAttribute('aria-multiselectable', 'true');
    this.rows = this.document.createElement('div');
    this.rows.className = `${this.options.cssPrefix}-rows`;
    this.rows.setAttribute('role', 'presentation');
    this.tree.append(this.rows);
    parent.classList.add(`${this.options.cssPrefix}-navigator`);
    parent.append(this.location, this.status, this.empty, this.tree);

    if (options.drag) {
      this.drag = this._register(instantiation.createInstance(
        NavigatorDrag<N, S>, this.tree, state, options.cssPrefix, options.drag,
        key => this.mountedRows.get(key)?.element, () => this.drawRows(true),
      ));
    }

    this._register(addDisposableListener(this.tree, 'scroll', () => this.drawRows()));
    this._register(addDisposableListener(this.tree, 'keydown', event => this.onKeyDown(event)));
    this._register(addDisposableListener(this.rows, 'mousedown', event => {
      if (event.button === 0 && (event.target as HTMLElement).closest('button')) {
        event.preventDefault();
      }
    }));
    this._register(addDisposableListener(this.rows, 'click', event => {
      const line = this.lineAt(event.target);
      if (!line) {
        return;
      }
      this.tree.focus({ preventScroll: true });
      if (line.kind === 'up') {
        // The second click of a double click lands on the next `..` and would go up one more level.
        if (event.detail <= 1) {
          this.state.up();
        }
      } else if ((event.target as HTMLElement).closest('button')) {
        if (event.detail <= 1) {
          this.state.toggle(line.key);
        }
      } else {
        this.state.select(line.key, event.ctrlKey || event.metaKey);
      }
    }));
    this._register(addDisposableListener(this.rows, 'dblclick', event => {
      const line = this.lineAt(event.target);
      if (line?.kind === 'node' && !(event.target as HTMLElement).closest('button')) {
        this.activate(line);
      }
    }));
    this._register(addDisposableListener(this.rows, 'contextmenu', event => {
      const line = this.lineAt(event.target);
      if (line) {
        // The parent row has no menu of its own, and the browser's menu does not belong here either.
        event.preventDefault();
      }
      if (line?.kind === 'node') {
        if (!this.state.selected.has(line.key)) {
          this.state.select(line.key);
        }
        this.showContextMenu({ x: event.clientX, y: event.clientY });
      }
    }));
    this._register(this.state.onDidChange(() => this.render()));
    this.render();
    void this.state.ensureLoaded();
  }

  layoutBody(): void {
    this.drawRows(true);
  }

  private lineAt(target: EventTarget | null): NavigatorLine<N> | undefined {
    const key = (target as HTMLElement | null)?.closest<HTMLElement>('[data-key]')?.dataset.key;
    return key === undefined ? undefined : this.state.lines[this.positions.get(key) ?? -1];
  }

  private render(): void {
    const { cursor, folderId, index, lines } = this.state;
    const path = index ? breadcrumb(folderId, index).join(' / ') : '';
    this.location.textContent = path;
    this.location.title = path;
    this.location.hidden = !path;
    this.status.textContent = this.state.error || (index ? '' : this.options.loadingMessage);
    this.status.hidden = !this.status.textContent;
    const hideEmpty = !index || index.nodes.size !== 0;
    const focusTree = this.options.renderEmpty && hideEmpty && this.empty.contains(this.document.activeElement);
    this.empty.hidden = hideEmpty;
    this.tree.setAttribute('aria-busy', String(this.state.busy || !index && !this.state.error));
    if (this.previousLines !== lines) {
      this.positions = new Map(lines.map((line, index) => [line.key, index]));
      this.rows.style.height = `${lines.length * ROW_HEIGHT}px`;
      this.previousLines = lines;
    }
    if (this.previousFolder !== folderId) {
      this.tree.scrollTop = 0;
      this.previousFolder = folderId;
    }
    if (cursor !== null && (cursor !== this.previousCursor || this.state.editing !== this.editor?.edit)) {
      this.reveal(cursor);
    }
    this.previousCursor = cursor;
    this.drawRows(true);
    this.drawEditor();
    if (focusTree) {
      this.tree.focus({ preventScroll: true });
    }
  }

  private reveal(key: string): void {
    const at = this.positions.get(key);
    if (at !== undefined) {
      this.tree.scrollTop = revealOffset(this.tree.scrollTop, this.tree.clientHeight, at * ROW_HEIGHT, ROW_HEIGHT);
    }
  }

  private drawRows(force = false): void {
    const { start, end } = windowRange(this.tree.scrollTop, this.tree.clientHeight, ROW_HEIGHT, this.state.lines.length);
    if (!force && start === this.lastStart && end === this.lastEnd) {
      return;
    }
    this.lastStart = start;
    this.lastEnd = end;
    const visible = new Set<string>();
    let nextElement = this.rows.firstElementChild;
    for (let at = start; at < end; at++) {
      const line = this.state.lines[at];
      visible.add(line.key);
      let mounted = this.mountedRows.get(line.key);
      const rowIcon = line.kind === 'node' ? this.options.rowIcon(line.node, line.dir) : undefined;
      if (!mounted || !this.drag?.isSource(mounted.element) && !this.sameRow(mounted, line, rowIcon)) {
        const element = this.drawRow(line, rowIcon);
        if (mounted?.element === nextElement) {
          nextElement = nextElement.nextElementSibling;
        }
        mounted?.element.remove();
        mounted = { line, element, icon: rowIcon };
        this.mountedRows.set(line.key, mounted);
      }
      this.updateRow(mounted.element, line, at);
      if (nextElement === mounted.element) {
        nextElement = nextElement.nextElementSibling;
      } else {
        this.rows.insertBefore(mounted.element, nextElement);
      }
    }
    for (const [key, mounted] of this.mountedRows) {
      if (!visible.has(key) && !this.drag?.isSource(mounted.element)) {
        mounted.element.remove();
        this.mountedRows.delete(key);
      }
    }
    const cursor = this.positions.get(this.state.cursor ?? '');
    if (cursor !== undefined && cursor >= start && cursor < end) {
      this.tree.setAttribute('aria-activedescendant', this.rowId(this.state.lines[cursor].key));
    } else {
      this.tree.removeAttribute('aria-activedescendant');
    }
  }

  private rowId(key: string): string {
    return `${this.tree.id}-${key}`;
  }

  private sameRow(mounted: MountedRow<N>, line: NavigatorLine<N>, rowIcon: RowIcon | undefined): boolean {
    if (mounted.icon?.id !== rowIcon?.id || mounted.icon?.label !== rowIcon?.label) {
      return false;
    }
    const previous = mounted.line;
    if (previous === line || previous.kind === 'up' && line.kind === 'up') {
      return true;
    }
    if (previous.kind !== 'node' || line.kind !== 'node' || previous.label !== line.label ||
        previous.dir !== line.dir || previous.depth !== line.depth) {
      return false;
    }
    const twig = line.twig;
    return previous.twig.every((part, index) => part === twig[index]);
  }

  private updateRow(row: HTMLElement, line: NavigatorLine<N>, at: number): void {
    row.style.top = `${at * ROW_HEIGHT}px`;
    row.setAttribute('aria-selected', String(this.state.selected.has(line.key)));
    row.classList.toggle(`${this.options.cssPrefix}-cursor`, this.state.cursor === line.key);
    this.drag?.markRow(row, line.key);
    if (line.kind === 'node' && line.dir) {
      row.setAttribute('aria-expanded', String(line.open));
      const toggle = row.querySelector('button')!;
      toggle.title = line.open ? 'Collapse' : 'Expand';
      toggle.setAttribute('aria-label', toggle.title);
      toggle.textContent = line.open ? '▾' : '▸';
    }
  }

  private drawRow(line: NavigatorLine<N>, rowIcon: RowIcon | undefined): HTMLElement {
    const row = this.document.createElement('div');
    row.className = `${this.options.cssPrefix}-row`;
    row.id = this.rowId(line.key);
    row.dataset.key = line.key;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(Math.max(1, line.depth)));
    if (line.kind === 'up') {
      row.setAttribute('aria-label', 'Parent Folder');
      row.append(icon(this.document, 'arrow-up'), UP_KEY);
      return row;
    }

    row.draggable = this.drag !== undefined;
    const branch = this.document.createElement('span');
    branch.className = `${this.options.cssPrefix}-twig`;
    branch.setAttribute('aria-hidden', 'true');
    for (const part of twigParts(line.twig)) {
      const segment = this.document.createElement('span');
      segment.className = `${this.options.cssPrefix}-twig-${part}`;
      segment.textContent = TWIG_TEXT[part];
      branch.append(segment);
    }
    row.append(branch);
    if (line.dir) {
      const toggle = this.document.createElement('button');
      toggle.className = `${this.options.cssPrefix}-toggle`;
      toggle.type = 'button';
      toggle.tabIndex = -1;
      row.append(toggle);
    } else {
      const spacer = this.document.createElement('span');
      spacer.className = `${this.options.cssPrefix}-toggle-spacer`;
      row.append(spacer);
    }
    const label = this.document.createElement('span');
    label.className = `${this.options.cssPrefix}-label`;
    label.textContent = line.label;
    label.title = line.label;
    row.setAttribute('aria-label', line.label);
    if (rowIcon) {
      row.append(icon(this.document, rowIcon.id));
      if (rowIcon.label) {
        row.setAttribute('aria-description', rowIcon.label);
      }
    }
    row.append(label);
    return row;
  }

  private drawEditor(): void {
    const edit = this.state.editing;
    if (edit !== this.editor?.edit) {
      this.editor?.element.remove();
      this.editor = undefined;
    }
    const node = edit && this.state.index?.nodes.get(edit.id);
    const at = edit && this.positions.get(edit.id);
    if (!edit || !node || at === undefined) {
      // The edited row is out of the list (its folder was collapsed): do not leave the field over another row.
      if (this.editor) {
        this.editor.element.hidden = true;
      }
      return;
    }
    if (!this.editor) {
      const element = this.document.createElement('div');
      element.className = `${this.options.cssPrefix}-inline-editor`;
      const input = this.document.createElement('input');
      input.type = 'text';
      input.value = node.title;
      input.setAttribute('aria-label', 'Title');
      const message = this.document.createElement('div');
      message.className = `${this.options.cssPrefix}-inline-error`;
      message.setAttribute('role', 'alert');
      message.id = `${this.tree.id}-title-error`;
      message.hidden = true;
      input.setAttribute('aria-describedby', message.id);
      element.append(input, message);
      this.tree.append(element);
      this.editor = { edit, input, message, element };
      input.addEventListener('input', () => this.setEditError(''));
      input.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.isComposing || event.keyCode === 229) {
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          this.state.cancelRename(edit);
          this.tree.focus({ preventScroll: true });
        } else if (event.key === 'Enter') {
          event.preventDefault();
          void this.commitTitle(edit, input.value);
        }
      });
      element.style.top = `${at * ROW_HEIGHT}px`;
      input.focus({ preventScroll: true });
      input.select();
    }
    this.editor.element.hidden = false;
    this.editor.element.style.top = `${at * ROW_HEIGHT}px`;
    this.editor.input.readOnly = this.state.busy;
  }

  private setEditError(text: string): void {
    if (this.editor) {
      this.editor.message.textContent = text;
      this.editor.message.hidden = !text;
      this.editor.input.setAttribute('aria-invalid', String(!!text));
    }
  }

  private async commitTitle(edit: TitleEdit, value: string): Promise<void> {
    if (this.state.busy) {
      return;
    }
    let title: string;
    try {
      title = this.state.normalizeTitle(value);
    } catch {
      this.setEditError(this.options.invalidTitle);
      return;
    }
    const result = await this.state.rename(edit.id, title, edit.revision);
    if (this.state.editing !== edit) {
      return;
    }
    if (result) {
      this.state.cancelRename(edit);
      this.tree.focus({ preventScroll: true });
    } else if (this.state.revision !== undefined && this.state.revision !== edit.revision) {
      edit.revision = this.state.revision;
      this.setEditError(this.options.titleReloaded);
    } else {
      this.setEditError('Could not save the title. Press Enter to try again.');
    }
  }

  private activate(line: NavigatorLine<N>): void {
    if (line.kind === 'up') {
      this.state.up();
    } else if (line.dir) {
      this.state.enter(line.key);
    } else {
      void this.options.activate?.(line.node);
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.drag && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      event.stopPropagation();
      void moveAdjacent(this.state, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    const lines = this.state.lines;
    const at = this.positions.get(this.state.cursor ?? '') ?? -1;
    const line = lines[at];
    let next: string | null = null;
    switch (event.key) {
      case 'ArrowUp': next = moveKey(lines, this.state.cursor, -1); break;
      case 'ArrowDown': next = moveKey(lines, this.state.cursor, 1); break;
      case 'Home': next = lines[0]?.key ?? null; break;
      case 'End': next = lines.at(-1)?.key ?? null; break;
      case 'PageUp': next = moveKey(lines, this.state.cursor, -Math.max(1, Math.floor(this.tree.clientHeight / ROW_HEIGHT))); break;
      case 'PageDown': next = moveKey(lines, this.state.cursor, Math.max(1, Math.floor(this.tree.clientHeight / ROW_HEIGHT))); break;
      case 'ArrowRight':
        if (line?.kind === 'node' && line.dir) {
          if (!line.open) {
            this.state.toggle(line.key);
          } else if (lines[at + 1]?.depth === line.depth + 1) {
            next = lines[at + 1].key;
          }
        }
        break;
      case 'ArrowLeft':
        if (line?.kind === 'node' && line.open) {
          this.state.toggle(line.key);
        } else {
          next = lines[parentLine(lines, at)]?.key ?? null;
        }
        break;
      case ' ':
        if (!line || line.kind === 'up') { return; }
        this.state.select(line.key, true);
        break;
      case 'Enter': if (line) { this.activate(line); } break;
      case 'Backspace': this.state.up(); break;
      case 'F2': if (line?.kind === 'node') { this.state.startRename(line.key); } break;
      case 'Delete': void this.state.deleteSelected(); break;
      case 'F10':
        if (!event.shiftKey) { return; }
        // Shift+F10 and the dedicated menu key use the current row as their anchor.
        this.openKeyboardMenu(line);
        break;
      case 'ContextMenu': this.openKeyboardMenu(line); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (next !== null) {
      if (this.options.keyboardMultiSelect && (event.ctrlKey || event.metaKey)) {
        this.state.focus(next);
      } else {
        this.state.select(next);
      }
      this.reveal(next);
      this.drawRows();
    }
  }

  private openKeyboardMenu(line: NavigatorLine<N> | undefined): void {
    if (line?.kind === 'node') {
      if (!this.state.selected.has(line.key)) {
        this.state.select(line.key);
      }
      this.showContextMenu(this.document.getElementById(this.rowId(line.key)) ?? this.tree);
    }
  }

  private showContextMenu(anchor: MenuAnchor): void {
    const context = this.contextKeys.getScopedContextKeyService(this.tree).createScoped();
    const node = this.state.singleSelection();
    context.createKey(this.options.selectionKindKey, node?.kind ?? '');
    this.options.setMenuContext?.(context, node);
    const groups = this.menus.getMenuActions(this.options.menuId, context);
    context.dispose();
    this.menu.value = this.contextMenus.showContextMenu({ getAnchor: () => anchor, getActions: () => groups });
  }
}
