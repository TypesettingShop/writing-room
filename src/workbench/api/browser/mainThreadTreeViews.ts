import { mainThreadCustomers } from './mainThreadCustomers.js';
import { MainThreadTreeViewsProxy, ExtHostTreeViewsProxy } from '../common/extHost.protocol.treeViews.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import type { Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IViewsService } from '../../services/views/browser/viewsService.js';
import { extensionResourceUri } from './extensionResourceUrls.js';
import type {
  AccessibilityInformationDto, DataTransferItemDto, ExtHostTreeViewsShape, MainThreadTreeViewsShape, TreeItemDto, TreeItemIconDto,
  TreeItemReference, TreeRevealOptionsDto, TreeViewOptionsDto, ViewBadgeDto,
} from '../common/extHost.protocol.js';

/** What the extension set on its `TreeView` beside the items. */
export interface TreeViewState {
  readonly title?: string;
  readonly description?: string;
  readonly message: string;
  readonly badge?: ViewBadgeDto;
}

export interface TreeDataSource {
  /** The extension's key in this host. */
  readonly extension?: string;
  readonly options?: TreeViewOptionsDto;
  readonly onDidRefresh: Event<readonly string[] | undefined>;
  readonly state?: TreeViewState;
  readonly onDidChangeState?: Event<void>;
  getItem(handle: string): Promise<TreeItemDto | undefined>;
  getChildren(parent?: string): Promise<TreeItemDto[]>;
  reference(handle: string): TreeItemReference;
  resolveTooltip?(handle: string, token: CancellationToken): Promise<string | undefined>;
  setSelection?(handles: readonly string[]): void;
  setExpanded?(handle: string, expanded: boolean): void;
  setVisible?(visible: boolean): void;
  setCheckboxState?(items: readonly [string, boolean][]): void;
  handleDrag?(handles: readonly string[], drag: string, token: CancellationToken): Promise<DataTransferItemDto[]>;
  handleDrop?(target: string | undefined, items: DataTransferItemDto[], drag: string | undefined, token: CancellationToken): Promise<void>;
  releaseDrag?(drag: string): void;
}

/** Shows a revealed item in the view's tree once the view is open. */
export type TreeRevealer = (chain: readonly string[], options: TreeRevealOptionsDto) => Promise<void>;

export class ExtensionTreeViews extends Disposable {
  private readonly providers = new Map<string, TreeDataSource>();
  private readonly revealers = new Map<string, TreeRevealer>();
  private readonly changed = this._register(new Emitter<string>());
  readonly onDidChangeProvider = this.changed.event;

  get(view: string): TreeDataSource | undefined {
    return this.providers.get(view);
  }

  register(view: string, source: TreeDataSource): IDisposable {
    if (this.providers.has(view)) {
      throw new Error(`Tree view '${view}' already has a data provider.`);
    }
    this.providers.set(view, source);
    this.changed.fire(view);
    return toDisposable(() => {
      if (this.providers.get(view) === source) {
        this.providers.delete(view);
        this.changed.fire(view);
      }
    });
  }

  /** The view's open tree answers `reveal` while it is registered. */
  registerRevealer(view: string, revealer: TreeRevealer): IDisposable {
    this.revealers.set(view, revealer);
    return toDisposable(() => {
      if (this.revealers.get(view) === revealer) {
        this.revealers.delete(view);
      }
    });
  }

  reveal(view: string, chain: readonly string[], options: TreeRevealOptionsDto): Promise<void> {
    return this.revealers.get(view)?.(chain, options) ?? Promise.resolve();
  }
}

interface TreeRegistration {
  readonly extension: string;
  readonly refresh: Emitter<readonly string[] | undefined>;
  readonly stateChanged: Emitter<void>;
  state: TreeViewState;
  disposable: IDisposable;
}

/** The host methods the workbench calls; a v0.1.0 host only had the first two. */
type ExtHostTreeViewsProxyShape = Pick<ExtHostTreeViewsShape, '$getChildren' | '$getTreeItem'> & Partial<ExtHostTreeViewsShape>;

export interface MainThreadTreeViewsContext {
  /** The folders, besides the extension's own, its icons may come from. */
  readonly iconFolders?: (extension: string) => readonly string[];
  readonly openView?: (view: string, focus: boolean) => Promise<unknown>;
}

const themeIconId = new RegExp('^' + ThemeIcon.iconIdExpression + '$');
const maxText = 10_000;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, maxText) : undefined;
}

function accessibility(value: unknown): AccessibilityInformationDto | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const { label, role } = value as { label?: unknown; role?: unknown };
  return typeof label === 'string' ? { label: label.slice(0, maxText), role: typeof role === 'string' && /^[a-z]+$/.test(role) ? role : undefined } : undefined;
}

export class MainThreadTreeViews implements MainThreadTreeViewsShape, IDisposable {
  private readonly entries = new Map<string, TreeRegistration>();

  constructor(
    private readonly proxy: ExtHostTreeViewsProxyShape,
    private readonly views: ExtensionTreeViews,
    private readonly owns: (key: string, view: string) => boolean,
    private readonly context: MainThreadTreeViewsContext = {},
  ) {}

  async $registerTreeViewDataProvider(extension: string, view: string, options?: TreeViewOptionsDto): Promise<void> {
    if (!this.owns(extension, view)) {
      throw new Error('No view is registered with id: ' + view);
    }
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.toLowerCase()) : [];
    const checked: TreeViewOptionsDto = {
      showCollapseAll: options?.showCollapseAll === true,
      canSelectMany: options?.canSelectMany === true,
      manageCheckboxStateManually: options?.manageCheckboxStateManually === true,
      dropMimeTypes: strings(options?.dropMimeTypes),
      dragMimeTypes: strings(options?.dragMimeTypes),
      hasHandleDrag: options?.hasHandleDrag === true,
      hasHandleDrop: options?.hasHandleDrop === true,
    };
    const refresh = new Emitter<readonly string[] | undefined>();
    const stateChanged = new Emitter<void>();
    const proxy = this.proxy;
    const sanitize = (item: TreeItemDto) => this.sanitize(extension, item);
    const entry: TreeRegistration = { extension, refresh, stateChanged, state: { message: '' }, disposable: Disposable.None };
    entry.disposable = this.views.register(view, {
      extension,
      options: checked,
      onDidRefresh: refresh.event,
      onDidChangeState: stateChanged.event,
      get state() { return entry.state; },
      getItem: async handle => {
        const item = await proxy.$getTreeItem(extension, view, handle);
        return item && sanitize(item);
      },
      getChildren: async parent => (await proxy.$getChildren(extension, view, parent)).map(sanitize),
      reference: handle => ({ kind: 'extensionTreeItem', extension, view, handle }),
      resolveTooltip: async (handle, token) => text(await proxy.$resolveTreeItem?.(extension, view, handle, token)),
      setSelection: handles => void proxy.$setSelection?.(extension, view, [...handles])?.catch(() => {}),
      setExpanded: (handle, expanded) => void proxy.$setExpanded?.(extension, view, handle, expanded)?.catch(() => {}),
      setVisible: visible => void proxy.$setVisible?.(extension, view, visible)?.catch(() => {}),
      setCheckboxState: items => void proxy.$changeCheckboxState?.(extension, view, items.map(([handle, state]) => [handle, state]))?.catch(() => {}),
      handleDrag: async (handles, drag, token) => {
        const items = await proxy.$handleDrag?.(extension, view, [...handles], drag, token) ?? [];
        return items.filter(item => typeof item?.mimeType === 'string' && typeof item.value === 'string')
          .map(({ mimeType, value }) => ({ mimeType: mimeType.toLowerCase(), value }));
      },
      handleDrop: (target, items, drag, token) => proxy.$handleDrop?.(extension, view, target, items, drag, token) ?? Promise.resolve(),
      releaseDrag: drag => void proxy.$releaseDrag?.(extension, drag)?.catch(() => {}),
    });
    this.entries.set(view, entry);
  }

  async $refresh(extension: string, view: string, handles?: string[]): Promise<void> {
    this.entry(extension, view)?.refresh.fire(handles);
  }

  async $disposeTree(extension: string, view: string): Promise<void> {
    const entry = this.entry(extension, view);
    if (entry) {
      this.drop(view, entry);
    }
  }

  async $reveal(extension: string, view: string, chain: string[], options: TreeRevealOptionsDto): Promise<void> {
    if (!this.entry(extension, view) || !Array.isArray(chain) || !chain.length || chain.some(handle => typeof handle !== 'string')) {
      return;
    }
    const expand = typeof options?.expand === 'number' ? Math.min(3, Math.max(0, Math.floor(options.expand) || 0)) : 0;
    const checked = { select: options?.select !== false, focus: options?.focus === true, expand };
    await this.context.openView?.(view, checked.focus);
    if (this.entry(extension, view)) {
      await this.views.reveal(view, chain, checked);
    }
  }

  async $setMessage(extension: string, view: string, message: string): Promise<void> {
    this.update(extension, view, { message: text(message) ?? '' });
  }

  async $setTitle(extension: string, view: string, title: string | undefined, description: string | undefined): Promise<void> {
    this.update(extension, view, { title: text(title), description: text(description) });
  }

  async $setBadge(extension: string, view: string, badge: ViewBadgeDto | undefined): Promise<void> {
    const value = badge && typeof badge.value === 'number' && Number.isFinite(badge.value) && typeof badge.tooltip === 'string'
      ? { value: Math.floor(Math.abs(badge.value)), tooltip: badge.tooltip.slice(0, maxText) } : undefined;
    this.update(extension, view, { badge: value });
  }

  private update(extension: string, view: string, change: Partial<TreeViewState>): void {
    const entry = this.entry(extension, view);
    if (entry) {
      entry.state = { ...entry.state, ...change };
      entry.stateChanged.fire();
    }
  }

  private entry(extension: string, view: string): TreeRegistration | undefined {
    const entry = this.entries.get(view);
    return entry?.extension === extension ? entry : undefined;
  }

  /** Keeps what the workbench can show from an item the extension sent, dropping icons outside its folders. */
  private sanitize(extension: string, item: TreeItemDto): TreeItemDto {
    const checkbox = item.checkbox && typeof item.checkbox === 'object' && typeof item.checkbox.checked === 'boolean' ? {
      checked: item.checkbox.checked,
      tooltip: text(item.checkbox.tooltip),
      accessibilityInformation: accessibility(item.checkbox.accessibilityInformation),
    } : undefined;
    return {
      ...item,
      label: text(item.label) ?? '',
      description: text(item.description),
      tooltip: text(item.tooltip),
      collapsible: item.collapsible === 1 || item.collapsible === 2 ? item.collapsible : 0,
      contextValue: text(item.contextValue),
      icon: this.icon(extension, item.icon),
      accessibilityInformation: accessibility(item.accessibilityInformation),
      checkbox,
      resolvable: item.resolvable === true ? true : undefined,
    };
  }

  private icon(extension: string, icon: unknown): TreeItemIconDto | undefined {
    if (!icon || typeof icon !== 'object') {
      return undefined;
    }
    const value = icon as Partial<Record<'kind' | 'id' | 'color', unknown>> & { light?: unknown; dark?: unknown };
    if (value.kind === 'theme') {
      if (typeof value.id !== 'string' || !themeIconId.test(value.id)) {
        return undefined;
      }
      return { kind: 'theme', id: value.id, color: typeof value.color === 'string' && /^[\w.-]+$/.test(value.color) ? value.color : undefined };
    }
    if (value.kind === 'uri') {
      const folders = this.context.iconFolders?.(extension) ?? [];
      const allowed = (uri: unknown) => URI.isUri(uri) ? extensionResourceUri(uri.toString(), folders) : undefined;
      const light = allowed(value.light);
      const dark = allowed(value.dark);
      return light && dark ? { kind: 'uri', light, dark } : undefined;
    }
    return undefined;
  }

  private drop(view: string, entry: TreeRegistration): void {
    this.entries.delete(view);
    entry.disposable.dispose();
    entry.refresh.dispose();
    entry.stateChanged.dispose();
  }

  remove(extension: string): void {
    for (const [view, entry] of this.entries) {
      if (entry.extension === extension) {
        this.drop(view, entry);
      }
    }
  }

  dispose(): void {
    for (const [view, entry] of this.entries) {
      this.drop(view, entry);
    }
  }
}

/** A workspace folder as a folder address: with the trailing slash `extensionResourceUri` needs. */
function folderAddress(uri: URI): string {
  const value = uri.toString();
  return value.endsWith('/') ? value : value + '/';
}

mainThreadCustomers.register('treeViews', ({ rpc, treeViews, getExtension, instantiation }) => {
  const trees = new MainThreadTreeViews(rpc.getProxy(ExtHostTreeViewsProxy), treeViews,
    (key, viewId) => getExtension(key)?.views?.includes(viewId) ?? false, {
      iconFolders: key => {
        const owner = getExtension(key);
        if (!owner) {
          return [];
        }
        const workspace = instantiation.invokeFunction(accessor => accessor.get(IWorkspaceContextService)).getWorkspace();
        return [owner.location, ...workspace.folders.map(folder => folderAddress(folder.uri))];
      },
      openView: (view, focus) => instantiation.invokeFunction(accessor => accessor.get(IViewsService)).openView(view, focus),
    });
  rpc.set(MainThreadTreeViewsProxy, trees);
  return trees;
});
