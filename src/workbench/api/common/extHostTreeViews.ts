import type * as vscode from 'vscode';
import { Disposable, TreeItemCollapsibleState, tooltipText } from './extHostTypes.js';
import type { ExtHostTreeViewsShape, MainThreadTreeViewsShape, TreeItemDto, TreeItemReference } from './extHost.protocol.js';

interface TreeNode {
  readonly element: unknown;
  readonly parent: string | undefined;
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

class TreeRegistration extends Disposable {
  private readonly nodes = new Map<string, TreeNode>();
  private readonly children = new Map<string | undefined, Set<string>>();
  private readonly loads = new Map<string | undefined, object>();

  constructor(
    readonly extension: string, readonly view: string,
    private readonly provider: vscode.TreeDataProvider<unknown>, onDispose: () => void,
  ) {
    super(onDispose);
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
      const prepared = items.map(({ item, element }, index) => {
        const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
        let handle = item.id !== undefined ? 'id:' + pathPart(item.id) : existing[index];
        if (handle === undefined) {
          let count = occurrences.get(label) ?? 0;
          do {
            handle = (parent ?? '') + '/label:' + count++ + ':' + pathPart(label);
          } while (reserved.has(handle));
          occurrences.set(label, count);
        }
        const previous = this.nodes.get(handle);
        if (nodes.has(handle) || (previous && previous.parent !== parent)) {
          throw new Error(`Tree view '${this.view}' has duplicate item id '${item.id}'.`);
        }
        nodes.set(handle, { element, parent });
        return { handle, item };
      });
      const rows = prepared.map(({ handle, item }) => this.toDto(handle, item, nodes));
      if (this.loads.get(parent) !== request) {
        return [];
      }
      for (const old of this.children.get(parent) ?? []) {
        if (!nodes.has(old)) {
          this.removeNode(old);
        }
      }
      this.children.set(parent, new Set(nodes.keys()));
      for (const [handle, node] of nodes) {
        this.nodes.set(handle, node);
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
        return this.toDto(handle, item);
      }
    }
    return undefined;
  }

  private toDto(handle: string, item: vscode.TreeItem, pending?: ReadonlyMap<string, TreeNode>): TreeItemDto {
    const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
    let args: unknown[] | undefined;
    if (item.command?.arguments) {
      const nodes = [...pending ?? [], ...this.nodes];
      try {
        args = structuredClone(item.command.arguments.map(argument => {
          const match = nodes.find(([, node]) => node.element === argument);
          return match ? this.reference(match[0]) : argument;
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
    };
  }

  private removeNode(handle: string): void {
    for (const child of this.children.get(handle) ?? []) {
      this.removeNode(child);
    }
    this.nodes.delete(handle);
    this.children.delete(handle);
    this.loads.delete(handle);
  }

  override dispose(): void {
    super.dispose();
    this.nodes.clear();
    this.children.clear();
    this.loads.clear();
  }
}

export class ExtHostTreeViews implements ExtHostTreeViewsShape {
  private readonly views = new Map<string, TreeRegistration>();

  constructor(
    private readonly proxy: MainThreadTreeViewsShape,
    private readonly registeredViews: (extension: string) => readonly string[],
  ) {}

  createTreeView<T>(extension: string, view: string, provider: vscode.TreeDataProvider<T>): vscode.TreeView<T> {
    if (!this.registeredViews(extension).includes(view)) {
      throw new Error('No view is registered with id: ' + view);
    }
    if (this.views.has(view)) {
      throw new Error(`Tree view '${view}' already has a data provider.`);
    }
    let listener: vscode.Disposable | undefined;
    const entry = new TreeRegistration(extension, view, provider as vscode.TreeDataProvider<unknown>, () => {
      this.views.delete(view);
      listener?.dispose();
      void this.proxy.$disposeTree(extension, view).catch(() => {});
    });
    this.views.set(view, entry);
    void this.proxy.$registerTreeViewDataProvider(extension, view).catch(error => {
      if (this.views.get(view) === entry) {
        entry.dispose();
        console.error(error);
      }
    });
    try {
      listener = provider.onDidChangeTreeData?.(element => {
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
    return new Disposable(() => entry.dispose());
  }

  async $getTreeItem(extension: string, view: string, handle: string): Promise<TreeItemDto | undefined> {
    const entry = this.views.get(view);
    return entry?.extension === extension ? entry.getItem(handle) : undefined;
  }

  async $getChildren(extension: string, view: string, parent?: string): Promise<TreeItemDto[]> {
    const entry = this.views.get(view);
    return entry?.extension === extension ? entry.getChildren(parent) : [];
  }

  resolveArgument(extension: string, value: unknown): unknown {
    if (isReference(value) && value.extension === extension) {
      const view = this.views.get(value.view);
      return view?.extension === extension ? view.element(value.handle) : undefined;
    }
    return value;
  }

  remove(extension: string): void {
    for (const entry of this.views.values()) {
      if (entry.extension === extension) {
        entry.dispose();
      }
    }
  }
}
