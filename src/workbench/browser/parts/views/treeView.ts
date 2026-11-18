import { runMenuAction } from '../../../../base/browser/ui/menu/menu.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IMenuService, MenuId, MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import type { ExtensionTreeViews, TreeDataSource } from '../../../api/browser/mainThreadTreeViews.js';
import type { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { TreeViewModel } from './treeViewModel.js';
import type { VisibleTreeItem } from './treeViewModel.js';
import './treeView.css';

export class TreeViewPane extends Disposable {
  private readonly content: HTMLElement;
  private readonly modelStore = this._register(new DisposableStore());
  private focused?: string;

  constructor(
    parent: HTMLElement,
    private readonly viewId: string,
    extensions: IExtensionService,
    private readonly views: ExtensionTreeViews,
    @ICommandService private readonly commands: ICommandService,
    @IContextKeyService private readonly context: IContextKeyService,
    @IMenuService private readonly menus: IMenuService,
    @IContextMenuService private readonly contextMenus: IContextMenuService,
  ) {
    super();
    this.content = parent.ownerDocument.createElement('div');
    this.content.className = 'extension-tree-content';
    parent.append(this.content);
    this._register(toDisposable(() => this.content.remove()));
    this._register(views.onDidChangeProvider(id => { if (id === this.viewId) { this.attach(); } }));
    this.attach();
    void extensions.activateByEvent('onView:' + viewId).catch(console.error);
  }

  private message(text: string): void {
    const message = this.content.ownerDocument.createElement('p');
    message.className = 'tree-view-message';
    message.textContent = text;
    this.content.replaceChildren(message);
  }

  private attach(): void {
    this.modelStore.clear();
    const source = this.views.get(this.viewId);
    if (!source) {
      this.focused = undefined;
      this.message('There is no data provider registered that can provide view data.');
      return;
    }
    const model = this.modelStore.add(new TreeViewModel(source));
    this.modelStore.add(model.onDidChange(() => this.render(source, model)));
    this.message('Loading…');
  }

  private render(source: TreeDataSource, model: TreeViewModel): void {
    const rows = model.rows;
    if (rows.length === 0) {
      this.message(model.error ?? 'No items to display.');
      return;
    }
    const document = this.content.ownerDocument;
    const hadFocus = this.content.contains(document.activeElement);
    const tree = document.createElement('div');
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', this.content.closest('section')?.getAttribute('aria-label') ?? this.viewId);
    if (!rows.some(({ item }) => item.handle === this.focused)) {
      this.focused = rows[0].item.handle;
    }
    const rendered = rows.map(row => this.renderRow(row, model, source));
    tree.append(...rendered);
    if (model.error) {
      const error = document.createElement('p');
      error.setAttribute('role', 'status');
      error.textContent = model.error;
      this.content.replaceChildren(tree, error);
    } else {
      this.content.replaceChildren(tree);
    }
    if (hadFocus) {
      rendered.find(row => row.tabIndex === 0)?.focus({ preventScroll: true });
    }
    tree.addEventListener('keydown', event => {
      const index = rows.findIndex(({ item }) => item.handle === this.focused);
      const row = rows[index];
      if (!row) {
        return;
      }
      let next = index;
      switch (event.key) {
        case 'ArrowDown': next = Math.min(rows.length - 1, index + 1); break;
        case 'ArrowUp': next = Math.max(0, index - 1); break;
        case 'Home': next = 0; break;
        case 'End': next = rows.length - 1; break;
        case 'ArrowRight':
          if (!row.expanded && row.item.collapsible !== 0) {
            model.setExpanded(row.item.handle, true);
          } else if (rows[index + 1]?.parent === row.item.handle) {
            next = index + 1;
          }
          break;
        case 'ArrowLeft':
          if (row.expanded) {
            model.setExpanded(row.item.handle, false);
          } else if (row.parent) {
            next = rows.findIndex(candidate => candidate.item.handle === row.parent);
          }
          break;
        case 'Enter':
        case ' ':
          this.run(row, model, source);
          break;
        case 'ContextMenu':
          this.showContext(row, source, rendered[index]);
          break;
        case 'F10':
          if (!event.shiftKey) { return; }
          this.showContext(row, source, rendered[index]);
          break;
        default: return;
      }
      event.preventDefault();
      if (next !== index) {
        rendered[next]?.focus();
      }
    });
  }

  private renderRow(row: VisibleTreeItem, model: TreeViewModel, source: TreeDataSource): HTMLElement {
    const { item, level, expanded } = row;
    const document = this.content.ownerDocument;
    const element = document.createElement('div');
    element.className = 'extension-tree-row';
    element.setAttribute('role', 'treeitem');
    element.setAttribute('aria-level', String(level));
    element.style.paddingInlineStart = (level - 1) * 14 + 'px';
    element.tabIndex = this.focused === item.handle ? 0 : -1;
    element.title = item.tooltip ?? '';
    const twistie = document.createElement('span');
    twistie.className = 'extension-tree-twistie';
    twistie.setAttribute('aria-hidden', 'true');
    if (item.collapsible !== 0) {
      element.setAttribute('aria-expanded', String(expanded));
      twistie.classList.add('codicon', expanded ? 'codicon-chevron-down' : 'codicon-chevron-right');
      twistie.addEventListener('click', event => {
        event.stopPropagation();
        element.focus();
        model.setExpanded(item.handle, !expanded);
      });
    }
    const label = document.createElement('span');
    label.textContent = item.label;
    element.append(twistie, label);
    if (item.description) {
      const description = document.createElement('span');
      description.className = 'extension-tree-description';
      description.textContent = item.description;
      element.append(description);
    }
    element.addEventListener('focus', () => {
      this.content.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.setAttribute('tabindex', '-1');
      this.focused = item.handle;
      element.tabIndex = 0;
    });
    element.addEventListener('click', () => {
      element.focus();
      this.run(row, model, source);
    });
    element.addEventListener('contextmenu', event => {
      event.preventDefault();
      element.focus();
      this.showContext(row, source, { x: event.clientX, y: event.clientY });
    });
    return element;
  }

  private run(row: VisibleTreeItem, model: TreeViewModel, source: TreeDataSource): void {
    const { item } = row;
    if (item.command) {
      const { id, args } = item.command;
      void runMenuAction({ id, label: item.label, run: () => this.commands.executeCommand(id, ...(args ?? [source.reference(item.handle)])) });
    } else if (item.collapsible !== 0) {
      model.setExpanded(item.handle, !row.expanded);
    }
  }

  private showContext(row: VisibleTreeItem, source: TreeDataSource, anchor: HTMLElement | { x: number; y: number }): void {
    const context = this.context.getScopedContextKeyService(this.content).createScoped();
    context.createKey('viewItem', row.item.contextValue);
    const groups = this.menus.getMenuActions(MenuId.ViewItemContext, context).map(([group, actions]) => [
      group, actions.map(action => action instanceof MenuItemAction
        ? { ...action, run: () => action.run(source.reference(row.item.handle)) }
        : action),
    ] as const);
    context.dispose();
    this.contextMenus.showContextMenu({ getAnchor: () => anchor, getActions: () => groups });
  }
}
