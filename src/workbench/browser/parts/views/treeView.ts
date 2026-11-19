import { runMenuAction } from '../../../../base/browser/ui/menu/menu.js';
import type { MenuAction, MenuGroup } from '../../../../base/browser/ui/menu/menu.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IMenuService, MenuId, MenuItemAction } from '../../../../platform/actions/common/actions.js';
import type { MenuActionGroup } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ColorScheme, IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { ExtensionTreeViews, TreeDataSource } from '../../../api/browser/mainThreadTreeViews.js';
import type { TreeItemDto, TreeItemIconDto, TreeRevealOptionsDto } from '../../../api/common/extHost.protocol.js';
import type { IViewBody } from '../../../common/views.js';
import type { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { TreeViewDragAndDrop } from './treeViewDragAndDrop.js';
import { TreeViewIcons } from './treeViewIcons.js';
import { TreeViewModel } from './treeViewModel.js';
import type { VisibleTreeItem } from './treeViewModel.js';
import { parseWelcomeLine, viewWelcomeContributions, welcomeLinkTarget } from './treeViewWelcome.js';
import { treeIconColor } from './treeViewColors.js';
import './treeView.css';

/** The view header's parts that the extension's `title`, `description` and `badge` change. */
class TreeViewHeader extends Disposable {
  private readonly section: HTMLElement | null;
  private readonly heading: HTMLElement | null;
  private readonly originalTitle: string | undefined;
  private readonly extras: HTMLElement;
  private readonly description: HTMLElement;
  private readonly badge: HTMLElement;
  private collapseAll: HTMLButtonElement | undefined;

  constructor(parent: HTMLElement) {
    super();
    this.section = parent.closest('section.view-pane');
    const header = this.section?.querySelector<HTMLElement>(':scope > .view-pane-header') ?? null;
    this.heading = header?.querySelector('h3') ?? null;
    this.originalTitle = this.heading?.textContent ?? undefined;
    const document = parent.ownerDocument;
    this.extras = document.createElement('span');
    this.extras.className = 'tree-view-header-extras';
    this.description = document.createElement('span');
    this.description.className = 'tree-view-description';
    this.badge = document.createElement('span');
    this.badge.className = 'tree-view-badge';
    this.badge.setAttribute('role', 'status');
    this.extras.append(this.description, this.badge);
    this.heading?.after(this.extras);
    this.update(undefined, undefined, undefined);
    this._register(toDisposable(() => {
      this.extras.remove();
      this.collapseAll?.remove();
      this.setTitle(undefined);
    }));
  }

  update(title: string | undefined, description: string | undefined, badge: { value: number; tooltip: string } | undefined): void {
    this.setTitle(title);
    this.description.textContent = description ?? '';
    this.description.hidden = !description;
    this.badge.hidden = !badge?.value;
    this.badge.textContent = badge?.value ? String(badge.value) : '';
    this.badge.title = badge?.tooltip ?? '';
    if (badge?.value) {
      this.badge.setAttribute('aria-label', badge.tooltip || String(badge.value));
    } else {
      this.badge.removeAttribute('aria-label');
    }
  }

  /** Shows a Collapse All button in the header while `run` is given. */
  setCollapseAll(run: (() => void) | undefined): void {
    if (!run) {
      this.collapseAll?.remove();
      this.collapseAll = undefined;
      return;
    }
    if (!this.collapseAll) {
      const button = this.extras.ownerDocument.createElement('button');
      button.type = 'button';
      button.className = 'tree-view-collapse-all codicon codicon-collapse-all';
      button.setAttribute('aria-label', 'Collapse All');
      button.title = 'Collapse All';
      this.heading?.parentElement?.append(button);
      this.collapseAll = button;
    }
    this.collapseAll.onclick = event => {
      event.stopPropagation();
      run();
    };
  }

  private setTitle(title: string | undefined): void {
    const value = title ?? this.originalTitle;
    if (this.heading && value !== undefined) {
      this.heading.textContent = value;
      this.section?.setAttribute('aria-label', value);
    }
  }
}

export class TreeViewPane extends Disposable implements IViewBody {
  private readonly content: HTMLElement;
  private readonly modelStore = this._register(new DisposableStore());
  private readonly header: TreeViewHeader;
  private readonly icons: TreeViewIcons;
  private readonly dnd: TreeViewDragAndDrop;
  /** The handle each drawn row shows. */
  private rowHandles = new WeakMap<Element, string>();
  private source: TreeDataSource | undefined;
  private model: TreeViewModel | undefined;
  private focused?: string;
  private selection: readonly string[] = [];
  private selectionAnchor?: string;
  private visible = false;
  private visibilityScheduled = false;
  private disposed = false;

  constructor(
    parent: HTMLElement,
    private readonly viewId: string,
    extensions: IExtensionService,
    private readonly views: ExtensionTreeViews,
    @ICommandService private readonly commands: ICommandService,
    @IContextKeyService private readonly context: IContextKeyService,
    @IMenuService private readonly menus: IMenuService,
    @IContextMenuService private readonly contextMenus: IContextMenuService,
    @IFileService files: IFileService,
    @IThemeService private readonly themes: IThemeService,
    @IOpenerService private readonly opener: IOpenerService,
  ) {
    super();
    this.content = parent.ownerDocument.createElement('div');
    this.content.className = 'extension-tree-content';
    parent.append(this.content);
    this._register(toDisposable(() => this.content.remove()));
    this.header = this._register(new TreeViewHeader(parent));
    this.icons = this._register(new TreeViewIcons(files));
    this.dnd = this._register(new TreeViewDragAndDrop(viewId, this.content, views, target => {
      const row = target instanceof Element ? target.closest<HTMLElement>('[role="treeitem"]') : null;
      const handle = row ? this.rowHandles.get(row) : undefined;
      return row && handle !== undefined ? { handle, row } : undefined;
    }, handle => this.selection.includes(handle) ? this.selection : [handle]));
    this._register(this.icons.onDidLoad(() => this.render()));
    this._register(themes.onDidColorThemeChange(() => this.render()));
    this._register(viewWelcomeContributions.onDidChange(() => this.render()));
    this._register(context.onDidChangeContext(event => {
      // Only the keys the welcome entries test: rendering can move focus, which changes other keys.
      const keys = new Set(viewWelcomeContributions.current.filter(entry => entry.view === this.viewId)
        .flatMap(entry => [...entry.when?.keys() ?? [], ...entry.enablement?.keys() ?? []]));
      if (keys.size && event.affectsSome(keys)) {
        this.render();
      }
    }));
    this._register(views.onDidChangeProvider(id => { if (id === this.viewId) { this.attach(); } }));
    this._register(views.registerRevealer(viewId, (chain, options) => this.reveal(chain, options)));
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.scheduleVisibility());
      observer.observe(this.content);
      this._register(toDisposable(() => observer.disconnect()));
    }
    this.attach();
    this.scheduleVisibility();
    void extensions.activateByEvent('onView:' + viewId).catch(console.error);
  }

  layoutBody(): void {
    this.scheduleVisibility();
  }

  private scheduleVisibility(): void {
    if (this.visibilityScheduled) {
      return;
    }
    this.visibilityScheduled = true;
    queueMicrotask(() => {
      this.visibilityScheduled = false;
      if (this.disposed) {
        return;
      }
      const bounds = this.content.getBoundingClientRect();
      const visible = this.content.isConnected && bounds.width > 0 && bounds.height > 0;
      if (visible !== this.visible) {
        this.visible = visible;
        this.source?.setVisible?.(visible);
      }
    });
  }

  private attach(): void {
    this.modelStore.clear();
    this.focused = undefined;
    this.selection = [];
    this.selectionAnchor = undefined;
    const source = this.source = this.views.get(this.viewId);
    this.model = undefined;
    this.dnd.sourceChanged();
    if (!source) {
      this.header.update(undefined, undefined, undefined);
      this.header.setCollapseAll(undefined);
      this.render();
      return;
    }
    const model = this.model = this.modelStore.add(new TreeViewModel(source));
    this.modelStore.add(model.onDidChange(() => this.render()));
    this.modelStore.add(model.onDidChangeExpansion(({ handle, expanded }) => source.setExpanded?.(handle, expanded)));
    if (source.onDidChangeState) {
      this.modelStore.add(source.onDidChangeState(() => this.render()));
    }
    this.header.setCollapseAll(source.options?.showCollapseAll ? () => model.collapseAll() : undefined);
    if (this.visible) {
      source.setVisible?.(true);
    }
    this.render();
  }

  private paragraph(text: string, className: string): HTMLElement {
    const message = this.content.ownerDocument.createElement('p');
    message.className = className;
    message.textContent = text;
    return message;
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    const { source, model } = this;
    const state = source?.state;
    this.header.update(state?.title, state?.description, state?.badge);
    const parts: HTMLElement[] = [];
    if (state?.message) {
      parts.push(this.paragraph(state.message, 'tree-view-message'));
    }
    const rows = model?.rows ?? [];
    const empty = !source || (model!.loaded && rows.length === 0);
    const welcome = empty && !state?.message ? this.renderWelcome() : undefined;
    const used = new Set<string>();
    let rendered: HTMLElement[] = [];
    const document = this.content.ownerDocument;
    const hadFocus = this.content.contains(document.activeElement);
    if (welcome) {
      parts.push(welcome);
    } else if (!source) {
      parts.push(this.paragraph('There is no data provider registered that can provide view data.', 'tree-view-message'));
    } else if (rows.length === 0) {
      parts.push(this.paragraph(model!.error ?? (model!.loaded ? 'No items to display.' : 'Loading…'), 'tree-view-message'));
    } else {
      const tree = document.createElement('div');
      tree.setAttribute('role', 'tree');
      tree.setAttribute('aria-label', this.content.closest('section')?.getAttribute('aria-label') ?? this.viewId);
      if (source.options?.canSelectMany) {
        tree.setAttribute('aria-multiselectable', 'true');
      }
      if (!rows.some(({ item }) => item.handle === this.focused)) {
        this.focused = rows[0].item.handle;
      }
      rendered = rows.map(row => this.renderRow(row, model!, source, used));
      tree.append(...rendered);
      tree.addEventListener('keydown', event => this.onKeyDown(event, rows, rendered, model!, source));
      parts.push(tree);
      if (model!.error) {
        const error = this.paragraph(model!.error, 'tree-view-error');
        error.setAttribute('role', 'status');
        parts.push(error);
      }
    }
    this.content.replaceChildren(...parts);
    this.icons.retain(used);
    if (hadFocus && !this.content.contains(document.activeElement)) {
      (rendered.find(row => row.tabIndex === 0) ?? welcome?.querySelector<HTMLElement>('a, button'))?.focus({ preventScroll: true });
    }
  }

  private renderWelcome(): HTMLElement | undefined {
    const entries = viewWelcomeContributions.current.filter(entry => entry.view === this.viewId
      && this.context.contextMatchesRules(entry.when));
    if (!entries.length) {
      return undefined;
    }
    const document = this.content.ownerDocument;
    const welcome = document.createElement('div');
    welcome.className = 'tree-view-welcome';
    for (const entry of entries) {
      const enabled = this.context.contextMatchesRules(entry.enablement);
      for (const line of entry.contents.split('\n')) {
        const parts = parseWelcomeLine(line.trim());
        if (!parts.length) {
          continue;
        }
        const run = (target: string) => {
          const action = welcomeLinkTarget(target, entry.commands);
          if (action && 'command' in action) {
            void this.opener.open(URI.from({ scheme: 'command', path: action.command }), { allowCommands: [action.command] });
          } else if (action) {
            void this.opener.open(action.url);
          }
        };
        const only = parts.length === 1 && 'target' in parts[0] ? parts[0] : undefined;
        if (only && welcomeLinkTarget(only.target, entry.commands)) {
          // A line that is just a link is a button, as in VS Code.
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'tree-view-welcome-button';
          button.textContent = only.label;
          button.disabled = !enabled;
          button.addEventListener('click', () => run(only.target));
          welcome.append(button);
          continue;
        }
        const paragraph = document.createElement('p');
        for (const part of parts) {
          if ('text' in part) {
            paragraph.append(part.text);
          } else if (welcomeLinkTarget(part.target, entry.commands)) {
            const link = document.createElement('a');
            link.href = '#';
            link.textContent = part.label;
            link.addEventListener('click', event => {
              event.preventDefault();
              if (enabled) {
                run(part.target);
              }
            });
            paragraph.append(link);
          } else {
            paragraph.append(part.label);
          }
        }
        welcome.append(paragraph);
      }
    }
    return welcome;
  }

  private onKeyDown(event: KeyboardEvent, rows: readonly VisibleTreeItem[], rendered: readonly HTMLElement[], model: TreeViewModel, source: TreeDataSource): void {
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
        this.setSelection([row.item.handle], row.item.handle);
        this.run(row, model, source);
        break;
      case ' ':
        if (row.item.checkbox) {
          this.toggleCheckbox(row.item.handle, model, source);
          break;
        }
        this.setSelection([row.item.handle], row.item.handle);
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
      const target = rows[next].item.handle;
      this.focused = target;
      if (event.shiftKey && source.options?.canSelectMany) {
        this.selectRange(rows, target);
      } else {
        this.setSelection([target], target);
      }
      rendered[next]?.focus();
    }
  }

  private renderIcon(icon: TreeItemIconDto | undefined, used: Set<string>): HTMLElement | undefined {
    const document = this.content.ownerDocument;
    if (icon?.kind === 'theme') {
      const element = document.createElement('span');
      element.className = 'extension-tree-icon ' + ThemeIcon.asClassName({ id: icon.id });
      element.setAttribute('aria-hidden', 'true');
      const color = icon.color && treeIconColor(icon.color);
      if (color) {
        element.style.color = color;
      }
      return element;
    }
    if (icon?.kind === 'uri') {
      const type = this.themes.getColorTheme().type;
      const light = type === ColorScheme.LIGHT || type === ColorScheme.HIGH_CONTRAST_LIGHT;
      const resource = URI.revive(light ? icon.light : icon.dark);
      used.add(resource.toString());
      const url = this.icons.get(resource);
      if (url) {
        const image = document.createElement('img');
        image.className = 'extension-tree-icon';
        image.alt = '';
        image.src = url;
        image.dataset.icon = light ? 'light' : 'dark';
        return image;
      }
      const placeholder = document.createElement('span');
      placeholder.className = 'extension-tree-icon';
      placeholder.setAttribute('aria-hidden', 'true');
      return placeholder;
    }
    return undefined;
  }

  private renderRow(row: VisibleTreeItem, model: TreeViewModel, source: TreeDataSource, used: Set<string>): HTMLElement {
    const { item, level, expanded } = row;
    const document = this.content.ownerDocument;
    const element = document.createElement('div');
    element.className = 'extension-tree-row';
    element.setAttribute('role', 'treeitem');
    element.setAttribute('aria-level', String(level));
    element.setAttribute('aria-selected', String(this.selection.includes(item.handle)));
    element.style.paddingInlineStart = (level - 1) * 14 + 'px';
    element.tabIndex = this.focused === item.handle ? 0 : -1;
    element.title = item.tooltip ?? '';
    if (item.accessibilityInformation) {
      element.setAttribute('aria-label', item.accessibilityInformation.label);
    } else if (item.checkbox) {
      // The check box has a name of its own, which would otherwise join the row's.
      element.setAttribute('aria-label', [item.label, item.description].filter(Boolean).join(' '));
    }
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
    element.append(twistie);
    if (item.checkbox) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'extension-tree-checkbox';
      checkbox.tabIndex = -1;
      checkbox.checked = item.checkbox.checked;
      checkbox.title = item.checkbox.tooltip ?? '';
      checkbox.setAttribute('aria-label', item.checkbox.accessibilityInformation?.label ?? item.checkbox.tooltip ?? item.label);
      checkbox.addEventListener('click', event => {
        event.stopPropagation();
        event.preventDefault();
        element.focus();
        this.toggleCheckbox(item.handle, model, source);
      });
      element.append(checkbox);
    }
    const icon = this.renderIcon(item.icon, used);
    if (icon) {
      element.append(icon);
    }
    const label = document.createElement('span');
    label.className = 'extension-tree-label';
    label.textContent = item.label;
    element.append(label);
    if (item.description) {
      const description = document.createElement('span');
      description.className = 'extension-tree-description';
      description.textContent = item.description;
      element.append(description);
    }
    this.rowHandles.set(element, item.handle);
    this.dnd.makeDraggable(element, item.handle);
    element.addEventListener('focus', () => {
      this.content.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.setAttribute('tabindex', '-1');
      this.focused = item.handle;
      element.tabIndex = 0;
    });
    if (item.resolvable && item.tooltip === undefined) {
      element.addEventListener('mouseenter', () => void this.resolveTooltip(item.handle, source, model), { once: true });
    }
    element.addEventListener('click', event => {
      element.focus();
      if (source.options?.canSelectMany && (event.ctrlKey || event.metaKey)) {
        const selected = this.selection.includes(item.handle);
        this.setSelection(selected ? this.selection.filter(handle => handle !== item.handle) : [...this.selection, item.handle], item.handle);
        return;
      }
      if (source.options?.canSelectMany && event.shiftKey) {
        this.selectRange(model.rows, item.handle);
        return;
      }
      this.setSelection([item.handle], item.handle);
      this.run(row, model, source);
    });
    element.addEventListener('contextmenu', event => {
      event.preventDefault();
      element.focus();
      if (!this.selection.includes(item.handle)) {
        this.setSelection([item.handle], item.handle);
      }
      this.showContext(row, source, { x: event.clientX, y: event.clientY });
    });
    return element;
  }

  /**
   * Checks or unchecks an item's box. Unless the extension manages the boxes, the loaded children
   * follow it and each parent is checked when all its children with a box are.
   */
  private toggleCheckbox(handle: string, model: TreeViewModel, source: TreeDataSource): void {
    const found = model.find(handle);
    if (!found?.item.checkbox) {
      return;
    }
    const checked = !found.item.checkbox.checked;
    const changes = new Map<string, boolean>([[handle, checked]]);
    if (!source.options?.manageCheckboxStateManually) {
      const visit = (parent: string) => {
        for (const child of model.childrenOf(parent)) {
          if (child.checkbox && child.checkbox.checked !== checked) {
            changes.set(child.handle, checked);
          }
          visit(child.handle);
        }
      };
      visit(handle);
      for (let parent = found.parent; parent !== undefined; parent = model.find(parent)?.parent) {
        const parentItem = model.find(parent)?.item;
        const boxes = model.childrenOf(parent).filter(child => child.checkbox);
        const all = boxes.every(child => changes.get(child.handle) ?? child.checkbox!.checked);
        if (!parentItem?.checkbox) {
          break;
        }
        if (parentItem.checkbox.checked !== all) {
          changes.set(parent, all);
        }
      }
    }
    // One change event for all of them: each event draws the whole tree again.
    model.replaceItems(new Map([...changes].map(([changed, value]) => [changed,
      (item: TreeItemDto) => item.checkbox ? { ...item, checkbox: { ...item.checkbox, checked: value } } : item])));
    source.setCheckboxState?.([...changes]);
  }

  private async resolveTooltip(handle: string, source: TreeDataSource, model: TreeViewModel): Promise<void> {
    if (!source.resolveTooltip) {
      return;
    }
    const cancellation = new CancellationTokenSource();
    const store = this.modelStore.add(toDisposable(() => cancellation.dispose(true)));
    try {
      const tooltip = await source.resolveTooltip(handle, cancellation.token);
      if (this.model === model && !cancellation.token.isCancellationRequested) {
        model.replaceItem(handle, item => ({ ...item, tooltip, resolvable: undefined }));
      }
    } catch {
      // The tooltip stays empty.
    } finally {
      this.modelStore.delete(store);
    }
  }

  private selectRange(rows: readonly VisibleTreeItem[], target: string): void {
    const handles = rows.map(({ item }) => item.handle);
    const from = handles.indexOf(this.selectionAnchor ?? target);
    const to = handles.indexOf(target);
    if (from < 0 || to < 0) {
      this.setSelection([target], target);
      return;
    }
    // Without an anchor the range starts at the target, which anchors the next one.
    this.setSelection(handles.slice(Math.min(from, to), Math.max(from, to) + 1), this.selectionAnchor ?? target);
  }

  private setSelection(handles: readonly string[], anchor: string | undefined): void {
    this.selectionAnchor = anchor;
    const changed = handles.length !== this.selection.length || handles.some((handle, index) => handle !== this.selection[index]);
    this.selection = handles;
    for (const row of this.content.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
      row.setAttribute('aria-selected', 'false');
    }
    const rows = this.model?.rows ?? [];
    const elements = [...this.content.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    rows.forEach(({ item }, index) => {
      if (handles.includes(item.handle)) {
        elements[index]?.setAttribute('aria-selected', 'true');
      }
    });
    if (changed) {
      this.source?.setSelection?.(handles);
    }
  }

  private async reveal(chain: readonly string[], options: TreeRevealOptionsDto): Promise<void> {
    const { model } = this;
    if (!model || !(await model.reveal(chain, options.expand)) || this.model !== model) {
      return;
    }
    const handle = chain[chain.length - 1];
    this.focused = handle;
    if (options.select) {
      this.setSelection([handle], handle);
    }
    this.render();
    const index = model.rows.findIndex(({ item }) => item.handle === handle);
    const row = this.content.querySelectorAll<HTMLElement>('[role="treeitem"]')[index];
    row?.scrollIntoView?.({ block: 'nearest' });
    if (options.focus) {
      row?.focus();
    }
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
    // Items inside a submenu get the tree item too, as the top-level items do.
    const withItem = (groups: readonly MenuActionGroup[]): MenuGroup[] => groups.map(([group, actions]) => [
      group, actions.map((action): MenuAction => action instanceof MenuItemAction
        ? { ...action, run: () => action.run(source.reference(row.item.handle)) }
        : { ...action, groups: withItem(action.groups) }),
    ] as const);
    const groups = withItem(this.menus.getMenuActions(MenuId.ViewItemContext, context));
    context.dispose();
    this.contextMenus.showContextMenu({ getAnchor: () => anchor, getActions: () => groups });
  }

  override dispose(): void {
    this.disposed = true;
    if (this.visible) {
      this.source?.setVisible?.(false);
    }
    super.dispose();
  }
}

