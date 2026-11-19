import { extHostApiRegistry } from './extHostApiRegistry.js';
import { MainThreadTreeViewsProxy, ExtHostTreeViewsProxy } from './extHost.protocol.treeViews.js';
import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { basename } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { DataTransfer, DataTransferItem, Disposable, TreeItem as BaseTreeItem, TreeItemCollapsibleState, tooltipText } from './extHostTypes.js';
import type {
  AccessibilityInformationDto, DataTransferItemDto, ExtHostTreeViewsShape, MainThreadTreeViewsShape, TreeItemCheckboxDto,
  TreeItemDto, TreeItemIconDto, TreeItemReference, TreeRevealOptionsDto, ViewBadgeDto,
} from './extHost.protocol.js';

export enum TreeItemCheckboxState { Unchecked = 0, Checked = 1 }

/** `TreeItem` with VS Code's second constructor, which takes the item's resource in place of its label. */
export class TreeItem extends BaseTreeItem {
  iconPath?: vscode.TreeItem['iconPath'];
  resourceUri?: vscode.Uri;
  accessibilityInformation?: vscode.AccessibilityInformation;
  checkboxState?: vscode.TreeItem['checkboxState'];

  constructor(labelOrResource?: vscode.TreeItem['label'] | vscode.Uri, collapsibleState?: TreeItemCollapsibleState) {
    if (URI.isUri(labelOrResource)) {
      super(undefined, collapsibleState);
      this.resourceUri = labelOrResource;
    } else {
      super(labelOrResource as vscode.TreeItem['label'], collapsibleState);
    }
  }
}

const revealParentRequired = "Required registered TreeDataProvider to implement 'getParent' method to access 'reveal' method";
const maxRevealDepth = 1000;

interface TreeNode {
  readonly element: unknown;
  readonly parent: string | undefined;
  /** The full refresh this node was last listed in; a node from an earlier one may move to another parent. */
  readonly generation: number;
}

function pathPart(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('/', '%2F');
}

function isReference(value: unknown): value is TreeItemReference {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'extensionTreeItem'
    && 'extension' in value && typeof value.extension === 'string'
    && 'view' in value && typeof value.view === 'string'
    && 'handle' in value && typeof value.handle === 'string';
}

function accessibility(value: unknown): AccessibilityInformationDto | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const { label, role } = value as { label?: unknown; role?: unknown };
  return typeof label === 'string' ? { label, role: typeof role === 'string' ? role : undefined } : undefined;
}

function checkbox(value: vscode.TreeItem['checkboxState']): TreeItemCheckboxDto | undefined {
  if (value === TreeItemCheckboxState.Checked || value === TreeItemCheckboxState.Unchecked) {
    return { checked: value === TreeItemCheckboxState.Checked };
  }
  if (value && typeof value === 'object' && (value.state === TreeItemCheckboxState.Checked || value.state === TreeItemCheckboxState.Unchecked)) {
    return {
      checked: value.state === TreeItemCheckboxState.Checked,
      tooltip: typeof value.tooltip === 'string' ? value.tooltip : undefined,
      accessibilityInformation: accessibility(value.accessibilityInformation),
    };
  }
  return undefined;
}

/** The icon as the workbench draws it. A string path has no meaning in the browser and is ignored. */
function icon(value: unknown): TreeItemIconDto | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if (URI.isUri(value)) {
    return { kind: 'uri', light: value, dark: value };
  }
  const { light, dark } = value as { light?: unknown; dark?: unknown };
  if (URI.isUri(light) && URI.isUri(dark)) {
    return { kind: 'uri', light, dark };
  }
  const { id, color } = value as { id?: unknown; color?: unknown };
  if (typeof id === 'string' && !('scheme' in value)) {
    const colorId = color && typeof color === 'object' ? (color as { id?: unknown }).id : undefined;
    return { kind: 'theme', id, color: typeof colorId === 'string' ? colorId : undefined };
  }
  return undefined;
}

function itemLabel(item: vscode.TreeItem): string {
  const label = typeof item.label === 'string' ? item.label : item.label?.label;
  if (label !== undefined) {
    return label;
  }
  return URI.isUri(item.resourceUri) ? basename(item.resourceUri as URI) : '';
}

function revealOptions(options: Parameters<vscode.TreeView<unknown>['reveal']>[1]): TreeRevealOptionsDto {
  const expand = options?.expand;
  return {
    select: options?.select ?? true,
    focus: options?.focus ?? false,
    expand: typeof expand === 'number' ? Math.min(3, Math.max(0, Math.floor(expand) || 0)) : expand ? 1 : 0,
  };
}

/** A file dropped from the operating system; its bytes came with the drop, up to the size limit. */
class FileDataTransferItem extends DataTransferItem {
  readonly #file: vscode.DataTransferFile;

  constructor(name: string, data: Uint8Array | undefined) {
    super('');
    this.#file = {
      name,
      data: () => data ? Promise.resolve(data) : Promise.reject(new Error(`The file '${name}' is too large to drop.`)),
    };
  }

  override asFile(): vscode.DataTransferFile {
    return this.#file;
  }
}

class TreeRegistration extends Disposable {
  private readonly nodes = new Map<string, TreeNode>();
  private readonly children = new Map<string | undefined, Set<string>>();
  private readonly loads = new Map<string | undefined, object>();
  /** The `TreeItem` the provider last gave for each handle, which `resolveTreeItem` and check boxes update. */
  private readonly items = new Map<string, vscode.TreeItem>();
  private generation = 0;
  private selected: string[] = [];
  private isVisible = false;
  disposed = false;

  readonly expanded = new Emitter<vscode.TreeViewExpansionEvent<unknown>>();
  readonly collapsed = new Emitter<vscode.TreeViewExpansionEvent<unknown>>();
  readonly selectionChanged = new Emitter<vscode.TreeViewSelectionChangeEvent<unknown>>();
  readonly visibilityChanged = new Emitter<vscode.TreeViewVisibilityChangeEvent>();
  readonly checkboxChanged = new Emitter<vscode.TreeCheckboxChangeEvent<unknown>>();

  constructor(
    readonly extension: string, readonly view: string,
    readonly provider: vscode.TreeDataProvider<unknown>,
    readonly dragAndDrop: vscode.TreeDragAndDropController<unknown> | undefined,
    onDispose: () => void,
  ) {
    super(onDispose);
  }

  get selection(): unknown[] {
    return this.selected.flatMap(handle => this.nodes.has(handle) ? [this.nodes.get(handle)!.element] : []);
  }

  get visible(): boolean {
    return this.isVisible;
  }

  reference(handle: string): TreeItemReference {
    return { kind: 'extensionTreeItem', extension: this.extension, view: this.view, handle };
  }

  element(handle: string): unknown {
    return this.nodes.get(handle)?.element;
  }

  handles(elements: readonly unknown[]): string[] {
    return [...this.nodes].filter(([, node]) => elements.includes(node.element)).map(([handle]) => handle);
  }

  /** The tree is about to be listed again from the root: every node may reappear under another parent. */
  startFullRefresh(): void {
    this.generation++;
  }

  async getChildren(parent?: string): Promise<TreeItemDto[]> {
    const parentNode = parent === undefined ? undefined : this.nodes.get(parent);
    if (parent && !parentNode) {
      return [];
    }
    const request = {};
    this.loads.set(parent, request);
    try {
      const children = await this.provider.getChildren(parentNode?.element) ?? [];
      const items = await Promise.all(children.map(async element => ({ element, item: await this.provider.getTreeItem(element) })));
      const previousLabels = new Map<unknown, string[]>();
      for (const handle of this.children.get(parent) ?? []) {
        if (handle.startsWith('id:') && !handle.includes('/')) {
          continue;
        }
        const related = this.nodes.get(handle)?.element;
        const handles = previousLabels.get(related) ?? [];
        handles.push(handle);
        previousLabels.set(related, handles);
      }
      const existing = items.map(({ element, item }) =>
        item.id === undefined ? previousLabels.get(element)?.shift() : undefined);
      const reserved = new Set(existing);
      const occurrences = new Map<string, number>();
      const nodes = new Map<string, TreeNode>();
      const generation = this.generation;
      const prepared = items.map(({ item, element }, index) => {
        const label = itemLabel(item);
        let handle = item.id !== undefined ? 'id:' + pathPart(item.id) : existing[index];
        if (handle === undefined) {
          let count = occurrences.get(label) ?? 0;
          do {
            handle = (parent ?? '') + '/label:' + count++ + ':' + pathPart(label);
          } while (reserved.has(handle));
          occurrences.set(label, count);
        }
        const previous = this.nodes.get(handle);
        // Within one listing of the tree an id belongs to one parent. A node seen before the last full
        // refresh may have moved: its old parent's list no longer has it once it lands here.
        if (nodes.has(handle) || (previous && previous.parent !== parent && previous.generation === generation)) {
          throw new Error(`Tree view '${this.view}' has duplicate item id '${item.id}'.`);
        }
        nodes.set(handle, { element, parent, generation });
        return { handle, item };
      });
      let index: Map<unknown, string> | undefined;
      const rows = prepared.map(({ handle, item }) => this.toDto(handle, item, () => index ??= this.handleIndex(nodes)));
      if (this.loads.get(parent) !== request) {
        return [];
      }
      for (const old of this.children.get(parent) ?? []) {
        // A node that moved to another parent since keeps its new place.
        if (!nodes.has(old) && this.nodes.get(old)?.parent === parent) {
          this.removeNode(old);
        }
      }
      this.children.set(parent, new Set(nodes.keys()));
      for (const [handle, node] of nodes) {
        const previous = this.nodes.get(handle);
        if (previous && previous.parent !== parent) {
          this.children.get(previous.parent)?.delete(handle);
        }
        this.nodes.set(handle, node);
      }
      for (const { handle, item } of prepared) {
        this.items.set(handle, item);
      }
      return rows;
    } finally {
      if (this.loads.get(parent) === request) {
        this.loads.delete(parent);
      }
    }
  }

  async getItem(handle: string): Promise<TreeItemDto | undefined> {
    const node = this.nodes.get(handle);
    if (node) {
      const item = await this.provider.getTreeItem(node.element);
      if (this.nodes.get(handle) === node) {
        this.items.set(handle, item);
        return this.toDto(handle, item, () => this.handleIndex());
      }
    }
    return undefined;
  }

  async resolveTooltip(handle: string, token: CancellationToken): Promise<string | undefined> {
    const node = this.nodes.get(handle);
    const item = this.items.get(handle);
    if (!node || !item || !this.provider.resolveTreeItem) {
      return undefined;
    }
    const resolved = await this.provider.resolveTreeItem(item, node.element, token as vscode.CancellationToken) ?? item;
    if (token.isCancellationRequested || this.nodes.get(handle) !== node) {
      return undefined;
    }
    if (resolved.tooltip !== undefined) {
      item.tooltip = resolved.tooltip;
    }
    return tooltipText(item.tooltip);
  }

  setSelection(handles: readonly string[]): void {
    const next = handles.filter(handle => this.nodes.has(handle));
    if (next.length !== this.selected.length || next.some((handle, index) => handle !== this.selected[index])) {
      this.selected = next;
      this.selectionChanged.fire({ selection: this.selection });
    }
  }

  setExpanded(handle: string, expanded: boolean): void {
    const node = this.nodes.get(handle);
    if (node) {
      (expanded ? this.expanded : this.collapsed).fire({ element: node.element });
    }
  }

  setVisible(visible: boolean): void {
    if (this.isVisible !== visible) {
      this.isVisible = visible;
      this.visibilityChanged.fire({ visible });
    }
  }

  changeCheckboxState(changes: readonly [string, boolean][]): void {
    const items: [unknown, TreeItemCheckboxState][] = [];
    for (const [handle, checked] of changes) {
      const node = this.nodes.get(handle);
      const item = this.items.get(handle);
      if (!node || !item || item.checkboxState === undefined) {
        continue;
      }
      const state = checked ? TreeItemCheckboxState.Checked : TreeItemCheckboxState.Unchecked;
      item.checkboxState = typeof item.checkboxState === 'object' ? { ...item.checkboxState, state } : state;
      items.push([node.element, state]);
    }
    if (items.length) {
      this.checkboxChanged.fire({ items });
    }
  }

  /** The handles of `element` and its ancestors from the root down, listing what is not known yet. */
  async revealChain(element: unknown): Promise<string[]> {
    const getParent = this.provider.getParent!.bind(this.provider);
    const chain = [element];
    for (let parent = await getParent(element); parent != null; parent = await getParent(parent)) {
      if (chain.includes(parent) || chain.length > maxRevealDepth) {
        throw new Error(`Tree view '${this.view}' has a cycle in its parents.`);
      }
      chain.unshift(parent);
    }
    const handles: string[] = [];
    let parent: string | undefined;
    for (const item of chain) {
      const find = () => [...this.children.get(parent) ?? []].find(handle => this.nodes.get(handle)?.element === item);
      let handle = find();
      // A listing the workbench started at the same time may win the race, so ask until one lands.
      for (let attempt = 0; handle === undefined && attempt < 2; attempt++) {
        await this.getChildren(parent);
        handle = find();
      }
      if (handle === undefined) {
        throw new Error(`Tree view '${this.view}' cannot find the element to reveal among its parent's children.`);
      }
      handles.push(handle);
      parent = handle;
    }
    return handles;
  }

  /** Maps each element to its first handle, looking at the batch being loaded before the known nodes. */
  private handleIndex(pending?: ReadonlyMap<string, TreeNode>): Map<unknown, string> {
    const index = new Map<unknown, string>();
    for (const nodes of [pending ?? new Map<string, TreeNode>(), this.nodes]) {
      for (const [handle, node] of nodes) {
        if (!index.has(node.element)) {
          index.set(node.element, handle);
        }
      }
    }
    return index;
  }

  private toDto(handle: string, item: vscode.TreeItem, index: () => ReadonlyMap<unknown, string>): TreeItemDto {
    const label = itemLabel(item);
    let args: unknown[] | undefined;
    if (item.command?.arguments) {
      const handles = index();
      try {
        args = structuredClone(item.command.arguments.map(argument => {
          const match = handles.get(argument);
          return match === undefined ? argument : this.reference(match);
        }));
      } catch {
        throw new Error(`Tree item '${label}' command arguments must be structured-cloneable.`);
      }
    }
    return {
      handle, label,
      description: typeof item.description === 'string' ? item.description : undefined,
      tooltip: tooltipText(item.tooltip),
      collapsible: item.collapsibleState ?? TreeItemCollapsibleState.None,
      contextValue: item.contextValue,
      command: item.command ? { id: item.command.command, args } : undefined,
      icon: icon(item.iconPath),
      accessibilityInformation: accessibility(item.accessibilityInformation),
      checkbox: checkbox(item.checkboxState),
      resolvable: item.tooltip === undefined && typeof this.provider.resolveTreeItem === 'function' ? true : undefined,
    };
  }

  private removeNode(handle: string): void {
    for (const child of this.children.get(handle) ?? []) {
      if (this.nodes.get(child)?.parent === handle) {
        this.removeNode(child);
      }
    }
    this.nodes.delete(handle);
    this.items.delete(handle);
    this.children.delete(handle);
    this.loads.delete(handle);
  }

  override dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    super.dispose();
    this.nodes.clear();
    this.items.clear();
    this.children.clear();
    this.loads.clear();
    this.selected = [];
    for (const emitter of [this.expanded, this.collapsed, this.selectionChanged, this.visibilityChanged, this.checkboxChanged]) {
      emitter.dispose();
    }
  }
}

type TreeViewOptions<T> = Omit<vscode.TreeViewOptions<T>, 'treeDataProvider'>;

/** The workbench methods the host calls; a v0.1.0 workbench only had the first three. */
type MainThreadTreeViewsProxyShape = Pick<MainThreadTreeViewsShape, '$registerTreeViewDataProvider' | '$refresh' | '$disposeTree'>
  & Partial<MainThreadTreeViewsShape>;

export class ExtHostTreeViews implements ExtHostTreeViewsShape {
  private readonly views = new Map<string, TreeRegistration>();
  /** What `handleDrag` filled, by extension and drag, until the drag ends. */
  private readonly drags = new Map<string, Map<string, Promise<vscode.DataTransfer | undefined>>>();

  constructor(
    private readonly proxy: MainThreadTreeViewsProxyShape,
    private readonly registeredViews: (extension: string) => readonly string[],
    private readonly viewNames: (extension: string, view: string) => string | undefined = () => undefined,
  ) {}

  createTreeView<T>(extension: string, view: string, provider: vscode.TreeDataProvider<T>, options: TreeViewOptions<T> = {}): vscode.TreeView<T> {
    if (!provider) {
      throw new Error('Options with treeDataProvider is mandatory');
    }
    if (!this.registeredViews(extension).includes(view)) {
      throw new Error('No view is registered with id: ' + view);
    }
    if (this.views.has(view)) {
      throw new Error(`Tree view '${view}' already has a data provider.`);
    }
    const dnd = options.dragAndDropController as vscode.TreeDragAndDropController<unknown> | undefined;
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
    let listener: vscode.Disposable | undefined;
    const entry = new TreeRegistration(extension, view, provider as vscode.TreeDataProvider<unknown>, dnd, () => {
      this.views.delete(view);
      listener?.dispose();
      void this.proxy.$disposeTree(extension, view).catch(() => {});
    });
    this.views.set(view, entry);
    void this.proxy.$registerTreeViewDataProvider(extension, view, {
      showCollapseAll: !!options.showCollapseAll,
      canSelectMany: !!options.canSelectMany,
      manageCheckboxStateManually: !!options.manageCheckboxStateManually,
      dropMimeTypes: strings(dnd?.dropMimeTypes),
      dragMimeTypes: strings(dnd?.dragMimeTypes),
      hasHandleDrag: typeof dnd?.handleDrag === 'function',
      hasHandleDrop: typeof dnd?.handleDrop === 'function',
    }).catch(error => {
      if (this.views.get(view) === entry) {
        entry.dispose();
        console.error(error);
      }
    });
    try {
      listener = provider.onDidChangeTreeData?.(element => {
        if (element == null) {
          entry.startFullRefresh();
        }
        const handles = element == null ? undefined : entry.handles(Array.isArray(element) ? element : [element]);
        if (handles?.length === 0) {
          return;
        }
        void this.proxy.$refresh(extension, view, handles).catch(() => {});
      });
    } catch (error) {
      entry.dispose();
      throw error;
    }
    return this.treeViewObject(entry, this.viewNames(extension, view)) as vscode.TreeView<T>;
  }

  private treeViewObject(entry: TreeRegistration, name: string | undefined): vscode.TreeView<unknown> {
    const { extension, view } = entry;
    const proxy = this.proxy;
    let title = name;
    let description: string | undefined;
    let message = '';
    let badge: ViewBadgeDto | undefined;
    const send = (call: () => Promise<void>) => {
      if (!entry.disposed) {
        void call().catch(() => {});
      }
    };
    const treeView: vscode.TreeView<unknown> = {
      onDidExpandElement: entry.expanded.event,
      onDidCollapseElement: entry.collapsed.event,
      onDidChangeSelection: entry.selectionChanged.event,
      onDidChangeVisibility: entry.visibilityChanged.event,
      onDidChangeCheckboxState: entry.checkboxChanged.event,
      get selection() { return entry.selection; },
      get visible() { return entry.visible; },
      get message() { return message; },
      set message(value: string) {
        message = typeof value === 'string' ? value : '';
        send(() => proxy.$setMessage?.(extension, view, message) ?? Promise.resolve());
      },
      get title() { return title; },
      set title(value: string | undefined) {
        title = typeof value === 'string' ? value : undefined;
        send(() => proxy.$setTitle?.(extension, view, title, description) ?? Promise.resolve());
      },
      get description() { return description; },
      set description(value: string | undefined) {
        description = typeof value === 'string' ? value : undefined;
        send(() => proxy.$setTitle?.(extension, view, title, description) ?? Promise.resolve());
      },
      get badge() { return badge; },
      set badge(value: vscode.ViewBadge | undefined) {
        if (value === undefined) {
          badge = undefined;
        } else if (value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value)
          && typeof value.tooltip === 'string') {
          badge = { value: Math.floor(Math.abs(value.value)), tooltip: value.tooltip };
        } else {
          return;
        }
        send(() => proxy.$setBadge?.(extension, view, badge) ?? Promise.resolve());
      },
      reveal: async (element, options) => {
        if (typeof entry.provider.getParent !== 'function') {
          throw new Error(revealParentRequired);
        }
        if (entry.disposed) {
          return;
        }
        const chain = await entry.revealChain(element);
        if (!entry.disposed) {
          await proxy.$reveal?.(extension, view, chain, revealOptions(options));
        }
      },
      dispose: () => entry.dispose(),
    };
    return treeView;
  }

  private entry(extension: string, view: string): TreeRegistration | undefined {
    const entry = this.views.get(view);
    return entry?.extension === extension ? entry : undefined;
  }

  async $getTreeItem(extension: string, view: string, handle: string): Promise<TreeItemDto | undefined> {
    return this.entry(extension, view)?.getItem(handle);
  }

  async $getChildren(extension: string, view: string, parent?: string): Promise<TreeItemDto[]> {
    return this.entry(extension, view)?.getChildren(parent) ?? [];
  }

  async $resolveTreeItem(extension: string, view: string, handle: string, token = CancellationToken.None): Promise<string | undefined> {
    return this.entry(extension, view)?.resolveTooltip(handle, token);
  }

  async $setSelection(extension: string, view: string, handles: string[]): Promise<void> {
    this.entry(extension, view)?.setSelection(handles);
  }

  async $setExpanded(extension: string, view: string, handle: string, expanded: boolean): Promise<void> {
    this.entry(extension, view)?.setExpanded(handle, expanded);
  }

  async $setVisible(extension: string, view: string, visible: boolean): Promise<void> {
    this.entry(extension, view)?.setVisible(visible);
  }

  async $changeCheckboxState(extension: string, view: string, items: [string, boolean][]): Promise<void> {
    this.entry(extension, view)?.changeCheckboxState(items);
  }

  async $handleDrag(extension: string, view: string, handles: string[], drag: string, token = CancellationToken.None): Promise<DataTransferItemDto[]> {
    const entry = this.entry(extension, view);
    const handleDrag = entry?.dragAndDrop?.handleDrag;
    const elements = entry ? handles.flatMap(handle => entry.element(handle) === undefined ? [] : [entry.element(handle)]) : [];
    if (!entry || !handleDrag || !elements.length) {
      return [];
    }
    const transfer = new DataTransfer();
    const filled = Promise.resolve(handleDrag.call(entry.dragAndDrop, elements, transfer, token as vscode.CancellationToken))
      .then(() => token.isCancellationRequested ? undefined : transfer);
    const drags = this.drags.get(extension) ?? new Map<string, Promise<vscode.DataTransfer | undefined>>();
    this.drags.set(extension, drags);
    drags.set(drag, filled);
    try {
      const result = await filled;
      const items: DataTransferItemDto[] = [];
      for (const [mimeType, item] of result ?? []) {
        if (!item.asFile()) {
          // A value with no text form, such as objects that refer to each other, still reaches a drop in this extension.
          const value = await Promise.resolve().then(() => item.asString()).catch(() => undefined);
          if (typeof value === 'string') {
            items.push({ mimeType, value });
          }
        }
      }
      return items;
    } catch (error) {
      drags.delete(drag);
      throw error;
    }
  }

  async $handleDrop(extension: string, view: string, target: string | undefined, items: DataTransferItemDto[], drag: string | undefined,
    token = CancellationToken.None): Promise<void> {
    const entry = this.entry(extension, view);
    const handleDrop = entry?.dragAndDrop?.handleDrop;
    if (!entry || !handleDrop) {
      return;
    }
    const element = target === undefined ? undefined : entry.element(target);
    if (target !== undefined && element === undefined) {
      return;
    }
    const transfer = new DataTransfer();
    for (const item of items) {
      transfer.set(item.mimeType, item.file ? new FileDataTransferItem(item.file.name, item.file.data) : new DataTransferItem(item.value));
    }
    // A drag from this extension's own tree carries the values `handleDrag` put in, not their strings.
    const source = drag === undefined ? undefined : await this.drags.get(extension)?.get(drag);
    for (const [mimeType, item] of source ?? []) {
      transfer.set(mimeType, item);
    }
    if (drag !== undefined) {
      this.drags.get(extension)?.delete(drag);
    }
    await handleDrop.call(entry.dragAndDrop, element, transfer, token as vscode.CancellationToken);
  }

  async $releaseDrag(extension: string, drag: string): Promise<void> {
    this.drags.get(extension)?.delete(drag);
  }

  resolveArgument(extension: string, value: unknown): unknown {
    if (isReference(value) && value.extension === extension) {
      const view = this.views.get(value.view);
      return view?.extension === extension ? view.element(value.handle) : undefined;
    }
    return value;
  }

  remove(extension: string): void {
    this.drags.delete(extension);
    for (const entry of this.views.values()) {
      if (entry.extension === extension) {
        entry.dispose();
      }
    }
  }
}

/** The view's name from the manifest, which a tree view's `title` starts as. */
function contributedViewName(manifest: { readonly contributes?: unknown }, view: string): string | undefined {
  const views = (manifest.contributes as { views?: unknown } | undefined)?.views;
  for (const list of views && typeof views === 'object' ? Object.values(views) : []) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (entry && typeof entry === 'object' && entry.id === view && typeof entry.name === 'string') {
        return entry.name;
      }
    }
  }
  return undefined;
}

extHostApiRegistry.register('treeViews', services => {
  const manifests = new Map<string, { readonly contributes?: unknown }>();
  const trees = new ExtHostTreeViews(services.rpc.getProxy(MainThreadTreeViewsProxy), services.getViews,
    (key, view) => {
      const manifest = manifests.get(key);
      return manifest && contributedViewName(manifest, view);
    });
  services.rpc.set(ExtHostTreeViewsProxy, trees);
  return {
    service: trees,
    create: extension => {
      const { key } = extension;
      manifests.set(key, extension.manifest);
      return {
        types: { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState },
        namespaces: {
          window: {
            registerTreeDataProvider: (view, provider) => {
              const treeView = trees.createTreeView(key, view, provider);
              return new Disposable(() => treeView.dispose());
            },
            createTreeView: (view, options) => trees.createTreeView(key, view, options?.treeDataProvider, options),
          } satisfies Pick<typeof vscode.window, 'registerTreeDataProvider' | 'createTreeView'>,
        },
      };
    },
    convertCommandArgument: (key, value) => trees.resolveArgument(key, value),
    release: key => {
      manifests.delete(key);
      trees.remove(key);
    },
  };
});
