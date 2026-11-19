import { mainThreadCustomers } from './mainThreadCustomers.js';
import { MainThreadTreeViewsProxy, ExtHostTreeViewsProxy } from '../common/extHost.protocol.treeViews.js';
import { Emitter } from '../../../base/common/event.js';
import type { Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { ExtHostTreeViewsShape, MainThreadTreeViewsShape, TreeItemDto, TreeItemReference } from '../common/extHost.protocol.js';

export interface TreeDataSource {
  readonly onDidRefresh: Event<readonly string[] | undefined>;
  getItem(handle: string): Promise<TreeItemDto | undefined>;
  getChildren(parent?: string): Promise<TreeItemDto[]>;
  reference(handle: string): TreeItemReference;
}

export class ExtensionTreeViews extends Disposable {
  private readonly providers = new Map<string, TreeDataSource>();
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
}

interface TreeRegistration {
  readonly extension: string;
  readonly refresh: Emitter<readonly string[] | undefined>;
  readonly disposable: IDisposable;
}

export class MainThreadTreeViews implements MainThreadTreeViewsShape, IDisposable {
  private readonly entries = new Map<string, TreeRegistration>();

  constructor(
    private readonly proxy: ExtHostTreeViewsShape,
    private readonly views: ExtensionTreeViews,
    private readonly owns: (key: string, view: string) => boolean,
  ) {}

  async $registerTreeViewDataProvider(extension: string, view: string): Promise<void> {
    if (!this.owns(extension, view)) {
      throw new Error('No view is registered with id: ' + view);
    }
    const refresh = new Emitter<readonly string[] | undefined>();
    const disposable = this.views.register(view, {
      onDidRefresh: refresh.event,
      getItem: handle => this.proxy.$getTreeItem(extension, view, handle),
      getChildren: parent => this.proxy.$getChildren(extension, view, parent),
      reference: handle => ({ kind: 'extensionTreeItem', extension, view, handle }),
    });
    this.entries.set(view, { extension, refresh, disposable });
  }

  async $refresh(extension: string, view: string, handles?: string[]): Promise<void> {
    const entry = this.entries.get(view);
    if (entry?.extension === extension) {
      entry.refresh.fire(handles);
    }
  }

  async $disposeTree(extension: string, view: string): Promise<void> {
    const entry = this.entries.get(view);
    if (entry?.extension === extension) {
      this.drop(view, entry);
    }
  }

  private drop(view: string, entry: TreeRegistration): void {
    this.entries.delete(view);
    entry.disposable.dispose();
    entry.refresh.dispose();
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

mainThreadCustomers.register('treeViews', ({ rpc, treeViews, getExtension }) => {
  const trees = new MainThreadTreeViews(rpc.getProxy(ExtHostTreeViewsProxy), treeViews,
    (key, viewId) => getExtension(key)?.views?.includes(viewId) ?? false);
  rpc.set(MainThreadTreeViewsProxy, trees);
  return trees;
});
