import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Severity, type IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../platform/notification/common/notification.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../platform/storage/common/storage.js';
import {
  buildIndex, firstKey, navigatorLines, UP_KEY, type NavigatorDestination, type NavigatorIndex,
  type NavigatorLine, type NavigatorNode, type NavigatorTreeOptions,
} from '../../common/navigator/navigatorTree.js';

export interface NavigatorTreeChange {
  readonly revision: number;
}

interface NodeChange<N extends NavigatorNode> extends NavigatorTreeChange {
  readonly node: N;
}

export interface NavigatorStore<N extends NavigatorNode> {
  getTree(workId: string): Promise<NavigatorTreeChange & { readonly nodes: readonly N[] }>;
  createNode(workId: string, input: NavigatorDestination & { kind: N['kind']; title: string }, expectedRevision: number): Promise<NodeChange<N>>;
  updateNode(workId: string, id: string, input: { title: string }, expectedRevision: number): Promise<NodeChange<N>>;
  moveNodes(workId: string, ids: readonly string[], destination: NavigatorDestination, expectedRevision: number): Promise<NavigatorTreeChange>;
  deleteNode(workId: string, id: string, expectedRevision: number): Promise<NavigatorTreeChange>;
}

interface NavigatorSource<S> {
  readonly store: S;
  readonly onDidChangeTree: Event<string>;
}

interface NavigatorStateOptions<N extends NavigatorNode> {
  readonly tree: NavigatorTreeOptions<N>;
  readonly storageKey: string;
  readonly isRevision: (value: unknown) => value is number;
  readonly normalizeTitle: (title: string) => string;
  readonly isConflict: (error: unknown) => boolean;
  readonly messages: {
    readonly loadFailed: string;
    readonly writeFailed: string;
    readonly conflictReloadFailed: string;
    readonly conflictReloaded: string;
  };
}

const hiddenKinds = new Set<string>();

interface SavedLocation {
  folderId?: string;
  expanded?: string[];
  selected?: string[];
  cursor?: string;
}

export interface TitleEdit {
  readonly id: string;
  revision: number;
}

export class NavigatorViewState<N extends NavigatorNode, S extends NavigatorStore<N>> extends Disposable {
  private readonly changed = this._register(new Emitter<void>());
  private readonly changedTree = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  readonly onDidChangeTree = this.changedTree.event;
  private tree: { index: NavigatorIndex<N>; revision: number } | undefined;
  private read: Promise<void> | undefined;
  private writePending = false;
  private disposed = false;
  private readonly expanded = new Set<string>();
  private selectedIds = new Set<string>();
  private currentFolder: string | null = null;
  private currentCursor: string | null = null;
  private titleEdit: TitleEdit | undefined;
  private renderedLines: readonly NavigatorLine<N>[] = [];
  private message = '';

  constructor(
    readonly workId: string | undefined,
    private readonly source: NavigatorSource<S>,
    private readonly options: NavigatorStateOptions<N>,
    private readonly storage: IStorageService,
    private readonly notifications: INotificationService,
    private readonly dialogs: IDialogService,
  ) {
    super();
    if (!this.workId) {
      return;
    }
    const saved = storage.getObject<SavedLocation>(options.storageKey, StorageScope.WORKSPACE);
    const { isId } = options.tree;
    this.currentFolder = isId(saved?.folderId) ? saved.folderId : null;
    this.currentCursor = saved?.cursor === UP_KEY || isId(saved?.cursor) ? saved.cursor : null;
    for (const id of Array.isArray(saved?.expanded) ? saved.expanded : []) {
      if (isId(id)) {
        this.expanded.add(id);
      }
    }
    this.selectedIds = new Set(Array.isArray(saved?.selected) ? saved.selected.filter(isId) : []);
    this._register(source.onDidChangeTree(workId => {
      if (workId === this.workId && !this.writePending) {
        void this.refresh();
      }
    }));
  }

  get index(): NavigatorIndex<N> | undefined { return this.tree?.index; }
  get revision(): number | undefined { return this.tree?.revision; }
  get folderId(): string | null { return this.currentFolder; }
  get cursor(): string | null { return this.currentCursor; }
  get selected(): ReadonlySet<string> { return this.selectedIds; }
  get lines(): readonly NavigatorLine<N>[] { return this.renderedLines; }
  get editing(): TitleEdit | undefined { return this.titleEdit; }
  get error(): string { return this.message; }
  get busy(): boolean { return this.writePending; }

  ensureLoaded(): Promise<void> {
    return this.tree ? Promise.resolve() : this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.workId || this.disposed) {
      return Promise.resolve();
    }
    return this.read ??= this.readTree(this.workId).finally(() => { this.read = undefined; });
  }

  private async readTree(workId: string): Promise<void> {
    try {
      const dto = await this.source.store.getTree(workId);
      if (this.disposed) {
        return;
      }
      const result = buildIndex(dto?.nodes, this.options.tree);
      if (!result.ok || !this.options.isRevision(dto?.revision)) {
        throw new Error(this.options.tree.invalidTree);
      }
      this.tree = { index: result.index, revision: dto.revision };
      this.message = '';
      if (this.currentFolder !== null) {
        const folder = result.index.nodes.get(this.currentFolder);
        if (!folder || !this.options.tree.types[folder.kind].container) {
          this.currentFolder = null;
        }
      }
      for (const id of this.expanded) {
        if (!result.index.nodes.has(id)) {
          this.expanded.delete(id);
        }
      }
      if (this.titleEdit && !result.index.nodes.has(this.titleEdit.id)) {
        this.titleEdit = undefined;
      }
      this.updateLines();
      this.changedTree.fire();
    } catch (error) {
      if (!this.disposed) {
        this.message = error instanceof Error ? error.message : this.options.messages.loadFailed;
        this.changed.fire();
      }
    }
  }

  private updateLines(): void {
    if (!this.tree) {
      return;
    }
    this.renderedLines = navigatorLines({ folderId: this.currentFolder, expanded: this.expanded, hiddenKinds }, this.tree.index);
    const visible = new Set(this.renderedLines.map(line => line.key));
    this.selectedIds = new Set([...this.selectedIds].filter(id => visible.has(id)));
    if (this.currentCursor === null || !visible.has(this.currentCursor)) {
      this.currentCursor = firstKey(this.renderedLines) ?? this.renderedLines[0]?.key ?? null;
    }
    this.saveLocation();
    this.changed.fire();
  }

  private saveLocation(): void {
    if (this.workId) {
      this.storage.store(this.options.storageKey, {
        folderId: this.currentFolder, expanded: [...this.expanded], selected: [...this.selectedIds], cursor: this.currentCursor,
      }, StorageScope.WORKSPACE, StorageTarget.MACHINE);
    }
  }

  select(key: string, extend = false): void {
    if (this.titleEdit?.id !== key) {
      this.titleEdit = undefined;
    }
    if (key === UP_KEY) {
      this.selectedIds.clear();
    } else if (!extend) {
      this.selectedIds = new Set([key]);
    } else if (this.selectedIds.has(key)) {
      this.selectedIds.delete(key);
    } else {
      this.selectedIds.add(key);
    }
    this.currentCursor = key;
    this.saveLocation();
    this.changed.fire();
  }

  singleSelection(): N | undefined {
    if (this.selectedIds.size === 1) {
      return this.index?.nodes.get(this.selectedIds.values().next().value!);
    }
    return undefined;
  }

  enter(id: string): void {
    const node = this.index?.nodes.get(id);
    if (node && this.options.tree.types[node.kind].container) {
      this.navigate(id, null);
    }
  }

  up(): void {
    const folder = this.currentFolder === null ? undefined : this.index?.nodes.get(this.currentFolder);
    if (folder) {
      this.navigate(folder.parentId, folder.id);
    }
  }

  private navigate(folderId: string | null, cursor: string | null): void {
    this.currentFolder = folderId;
    this.currentCursor = cursor;
    this.selectedIds = new Set(cursor ? [cursor] : []);
    this.titleEdit = undefined;
    this.updateLines();
  }

  toggle(id: string): void {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
    }
    this.updateLines();
  }

  collapseAll(): void {
    this.expanded.clear();
    this.updateLines();
  }

  startRename(id: string): void {
    if (this.index?.nodes.has(id) && this.revision !== undefined && !this.busy) {
      this.titleEdit = { id, revision: this.revision };
      this.changed.fire();
    }
  }

  cancelRename(edit: TitleEdit): void {
    if (this.titleEdit === edit) {
      this.titleEdit = undefined;
      this.changed.fire();
    }
  }

  creationParent(kind: N['kind'], selection = this.singleSelection()): string | null | undefined {
    const allowed = this.options.tree.types[kind].allowedParents;
    if (selection && allowed.includes(selection.kind)) {
      return selection.id;
    }
    const folder = this.currentFolder === null ? undefined : this.index?.nodes.get(this.currentFolder);
    for (let parent = folder; parent; parent = parent.parentId === null ? undefined : this.index?.nodes.get(parent.parentId)) {
      if (allowed.includes(parent.kind)) {
        return parent.id;
      }
    }
    return allowed.includes(null) ? null : undefined;
  }

  async create(kind: N['kind']): Promise<void> {
    const parentId = this.creationParent(kind);
    if (parentId === undefined) {
      return;
    }
    const result = await this.write((store, workId, revision) => store.createNode(workId, { kind, parentId, title: '' }, revision));
    if (!result || !this.index?.nodes.has(result.node.id)) {
      return;
    }
    this.reveal(result.node.id);
    this.startRename(result.node.id);
  }

  reveal(id: string, selection: readonly string[] = [id]): void {
    const node = this.index?.nodes.get(id);
    if (!node) {
      return;
    }
    let ancestor = node.parentId;
    while (ancestor !== null && ancestor !== this.currentFolder) {
      ancestor = this.index?.nodes.get(ancestor)?.parentId ?? null;
    }
    if (ancestor !== this.currentFolder) {
      this.currentFolder = node.parentId;
    }
    for (let parent = node.parentId; parent !== null && parent !== this.currentFolder;) {
      this.expanded.add(parent);
      parent = this.index?.nodes.get(parent)?.parentId ?? null;
    }
    this.currentCursor = id;
    this.selectedIds = new Set(selection);
    this.updateLines();
  }

  async deleteSelected(): Promise<void> {
    const node = this.singleSelection();
    const index = this.index;
    const revision = this.revision;
    if (!node || !index || revision === undefined || this.busy) {
      return;
    }
    const label = index.labels.get(node.id) ?? node.title;
    const suffix = this.options.tree.types[node.kind].container ? ' and everything in it' : '';
    const { result } = this.dialogs.prompt({
      type: Severity.Warning,
      message: `Delete "${label}"${suffix}?`,
      buttons: ['Cancel', 'Delete'],
      cancelButton: 0,
    });
    if (await result === 1) {
      await this.write((store, workId) => store.deleteNode(workId, node.id, revision));
    }
  }

  normalizeTitle(title: string): string {
    return this.options.normalizeTitle(title);
  }

  rename(id: string, title: string, revision: number): Promise<NavigatorTreeChange | undefined> {
    return this.write((store, workId) => store.updateNode(workId, id, { title: this.normalizeTitle(title) }, revision));
  }

  async write<T extends NavigatorTreeChange>(operation: (store: S, workId: string, revision: number) => Promise<T>): Promise<T | undefined> {
    if (!this.workId || this.revision === undefined || this.writePending || this.disposed) {
      return undefined;
    }
    const revision = this.revision;
    this.writePending = true;
    this.changed.fire();
    try {
      const result = await operation(this.source.store, this.workId, revision);
      // A read started before this write may contain its predecessor. Follow it with a fresh read.
      await this.read;
      await this.refresh();
      return result;
    } catch (error) {
      if (this.options.isConflict(error)) {
        await this.read;
        await this.refresh();
        this.notifications.warn(this.message
          ? this.options.messages.conflictReloadFailed
          : this.options.messages.conflictReloaded);
      } else {
        this.notifications.error(error instanceof Error ? error.message : this.options.messages.writeFailed);
      }
      return undefined;
    } finally {
      this.writePending = false;
      if (!this.disposed) {
        this.changed.fire();
      }
    }
  }

  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }
}
