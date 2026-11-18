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
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  error?: string;

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

  private find(handle: string): { item: TreeItemDto; parent: string | undefined } | undefined {
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
          this.requests.delete(handle);
          this.children.delete(handle);
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

  private async load(parent: string | undefined, refreshDescendants: boolean): Promise<void> {
    const request = {};
    this.requests.set(parent, request);
    try {
      const items = await this.source.getChildren(parent);
      if (this.requests.get(parent) !== request) {
        return;
      }
      const newHandles = new Set(items.map(item => item.handle));
      for (const old of this.children.get(parent) ?? []) {
        if (!newHandles.has(old.handle)) {
          this.forget(old.handle);
        }
      }
      this.children.set(parent, items);
      if (!parent) {
        this.error = undefined;
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

  override dispose(): void {
    this.requests.clear();
    this.refreshes.clear();
    super.dispose();
  }
}
