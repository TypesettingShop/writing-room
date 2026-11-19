import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { TreeDataSource } from '../../../api/browser/mainThreadTreeViews.js';
import type { TreeItemDto } from '../../../api/common/extHost.protocol.js';

export interface VisibleTreeItem {
  readonly item: TreeItemDto;
  readonly parent: string | undefined;
  readonly level: number;
  readonly expanded: boolean;
}

export class TreeViewModel extends Disposable {
  private readonly children = new Map<string | undefined, TreeItemDto[]>();
  private readonly expanded = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly requests = new Map<string | undefined, object>();
  private readonly refreshes = new Map<string, object>();
  private readonly loading = new Map<string | undefined, Promise<void>>();
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly expansionChanged = this._register(new Emitter<{ readonly handle: string; readonly expanded: boolean }>());
  /** The user or a reveal expanded or collapsed a node; the provider's initial expanded state does not count. */
  readonly onDidChangeExpansion = this.expansionChanged.event;
  error?: string;
  /** The root's children have arrived once. */
  loaded = false;

  constructor(private readonly source: TreeDataSource) {
    super();
    this._register(source.onDidRefresh(handles => {
      if (handles) {
        for (const handle of handles) {
          void this.refresh(handle);
        }
      } else {
        void this.load(undefined, true);
      }
    }));
    void this.load(undefined, false);
  }

  get rows(): VisibleTreeItem[] {
    const result: VisibleTreeItem[] = [];
    const visit = (parent: string | undefined, level: number) => {
      for (const item of this.children.get(parent) ?? []) {
        const expanded = this.expanded.has(item.handle) && item.collapsible !== 0;
        result.push({ item, parent, level, expanded });
        if (expanded) {
          visit(item.handle, level + 1);
        }
      }
    };
    visit(undefined, 1);
    return result;
  }

  setExpanded(handle: string, expanded: boolean): void {
    if (this.expanded.has(handle) !== expanded) {
      this.expansionChanged.fire({ handle, expanded });
    }
    if (expanded) {
      this.expanded.add(handle);
      if (!this.children.has(handle)) {
        void this.load(handle, false);
      }
    } else {
      this.expanded.delete(handle);
    }
    this.changed.fire();
  }

  /** Collapses every node, as the view's Collapse All does. */
  collapseAll(): void {
    for (const handle of [...this.expanded]) {
      this.expansionChanged.fire({ handle, expanded: false });
    }
    this.expanded.clear();
    this.changed.fire();
  }

  /**
   * Expands the ancestors in `chain` from the root down and then `levels` levels below its last node,
   * loading what is not loaded yet. Resolves to whether the last node is in the tree.
   */
  async reveal(chain: readonly string[], levels: number): Promise<boolean> {
    let parent: string | undefined;
    for (const [index, handle] of chain.entries()) {
      await this.ensureLoaded(parent);
      if (!this.children.get(parent)?.some(item => item.handle === handle)) {
        return false;
      }
      if (index < chain.length - 1) {
        this.expandLoaded(handle);
      }
      parent = handle;
    }
    let level = [chain[chain.length - 1]];
    for (let depth = 0; depth < levels && level.length; depth++) {
      const next: string[] = [];
      for (const handle of level) {
        const item = this.find(handle)?.item;
        if (item && item.collapsible !== 0) {
          this.expandLoaded(handle);
          await this.ensureLoaded(handle);
          next.push(...(this.children.get(handle) ?? []).map(child => child.handle));
        }
      }
      level = next;
    }
    this.changed.fire();
    return true;
  }

  /** Replaces a shown item, as when the user checked its box, until the provider sends it again. */
  replaceItem(handle: string, change: (item: TreeItemDto) => TreeItemDto): void {
    const found = this.find(handle);
    const items = found && this.children.get(found.parent);
    if (found && items) {
      items[items.indexOf(found.item)] = change(found.item);
      this.changed.fire();
    }
  }

  /** The loaded children of a node, or of the root. */
  childrenOf(handle: string | undefined): readonly TreeItemDto[] {
    return this.children.get(handle) ?? [];
  }

  private expandLoaded(handle: string): void {
    if (!this.expanded.has(handle)) {
      this.expanded.add(handle);
      this.expansionChanged.fire({ handle, expanded: true });
    }
  }

  private async ensureLoaded(parent: string | undefined): Promise<void> {
    // A load that a newer one replaced settles without children, so wait for the newer one too.
    for (let attempt = 0; attempt < 3 && !this.children.has(parent) && !this.isDisposed; attempt++) {
      await (this.loading.get(parent) ?? this.load(parent, false));
    }
  }

  find(handle: string): { item: TreeItemDto; parent: string | undefined } | undefined {
    for (const [parent, items] of this.children) {
      const item = items.find(candidate => candidate.handle === handle);
      if (item) {
        return { item, parent };
      }
    }
    return undefined;
  }

  private async refresh(handle: string): Promise<void> {
    const before = this.find(handle);
    if (!before) {
      return;
    }
    const request = {};
    this.refreshes.set(handle, request);
    try {
      const item = await this.source.getItem(handle);
      const items = this.children.get(before.parent);
      const index = items?.indexOf(before.item) ?? -1;
      if (item && items && index >= 0 && this.refreshes.get(handle) === request) {
        items[index] = item;
        if (this.expanded.has(handle) && item.collapsible !== 0) {
          void this.load(handle, true);
        } else {
          this.invalidate(handle);
        }
        this.changed.fire();
      }
    } catch (error) {
      if (this.refreshes.get(handle) === request) {
        this.error = error instanceof Error ? error.message : String(error);
        this.changed.fire();
      }
    } finally {
      if (this.refreshes.get(handle) === request) {
        this.refreshes.delete(handle);
      }
    }
  }

  private load(parent: string | undefined, refreshDescendants: boolean): Promise<void> {
    const loading = this.loadChildren(parent, refreshDescendants);
    this.loading.set(parent, loading);
    void loading.finally(() => {
      if (this.loading.get(parent) === loading) {
        this.loading.delete(parent);
      }
    });
    return loading;
  }

  private async loadChildren(parent: string | undefined, refreshDescendants: boolean): Promise<void> {
    const request = {};
    this.requests.set(parent, request);
    try {
      const items = await this.source.getChildren(parent);
      if (this.requests.get(parent) !== request) {
        return;
      }
      const newHandles = new Set(items.map(item => item.handle));
      // A node with a stable id may have moved here from another parent: it leaves that parent's list.
      for (const [other, list] of this.children) {
        if (other !== parent && list.some(item => newHandles.has(item.handle))) {
          this.children.set(other, list.filter(item => !newHandles.has(item.handle)));
        }
      }
      const old = this.children.get(parent) ?? [];
      this.children.set(parent, items);
      for (const item of old) {
        // A node that moved to another parent keeps its subtree and state there.
        if (!newHandles.has(item.handle) && !this.find(item.handle)) {
          this.forget(item.handle);
        }
      }
      if (!parent) {
        this.error = undefined;
        this.loaded = true;
      }
      for (const item of items) {
        if (!this.seen.has(item.handle)) {
          this.seen.add(item.handle);
          if (item.collapsible === 2) {
            this.expanded.add(item.handle);
          }
        }
        if (item.collapsible !== 0 && this.expanded.has(item.handle)
          && (refreshDescendants || !this.children.has(item.handle))) {
          void this.load(item.handle, refreshDescendants);
        } else if (refreshDescendants) {
          this.invalidate(item.handle);
        }
      }
      this.changed.fire();
    } catch (error) {
      if (this.requests.get(parent) === request) {
        this.error = error instanceof Error ? error.message : String(error);
        this.changed.fire();
      }
    } finally {
      if (this.requests.get(parent) === request) {
        this.requests.delete(parent);
      }
    }
  }

  /** Drops the cached rows under a hidden node so that expanding it asks the provider again. */
  private invalidate(handle: string): void {
    for (const child of this.children.get(handle) ?? []) {
      this.invalidate(child.handle);
    }
    this.children.delete(handle);
    this.requests.delete(handle);
  }

  private forget(handle: string): void {
    for (const child of this.children.get(handle) ?? []) {
      this.forget(child.handle);
    }
    this.children.delete(handle);
    this.requests.delete(handle);
    this.refreshes.delete(handle);
    this.expanded.delete(handle);
    this.seen.delete(handle);
  }

  private isDisposed = false;

  override dispose(): void {
    this.isDisposed = true;
    this.requests.clear();
    this.loading.clear();
    this.refreshes.clear();
    super.dispose();
  }
}
