import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IDialogService, Severity } from '../../../../platform/dialogs/common/dialogs.js';
import {
  isManuscriptId, isManuscriptRevision, manuscriptNodeTypes, ManuscriptStoreError, normalizeManuscriptTitle,
  type ManuscriptNode, type ManuscriptNodeKind,
} from '../../../../platform/manuscript/common/manuscript.js';
import type { ManuscriptStore, TreeChange } from '../../../../platform/manuscript/common/manuscriptStore.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IManuscriptService } from '../../../services/manuscript/common/manuscriptService.js';
import { IWorkService } from '../../../services/work/common/work.js';
import { buildIndex, firstKey, navigatorLines, UP_KEY, type ManuscriptIndex, type NavigatorLine } from '../common/manuscriptTree.js';

export const IManuscriptViewState = createDecorator<ManuscriptViewState>('manuscriptViewState');
const storageKey = 'workbench.manuscript.navigator';
const hiddenKinds = new Set<ManuscriptNodeKind>();

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

export class ManuscriptViewState extends Disposable {
  declare readonly _serviceBrand: undefined;
  private readonly changed = this._register(new Emitter<void>());
  private readonly changedTree = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  readonly onDidChangeTree = this.changedTree.event;
  readonly workId: string | undefined;
  private tree: { index: ManuscriptIndex; revision: number } | undefined;
  private read: Promise<void> | undefined;
  private writePending = false;
  private disposed = false;
  private readonly expanded = new Set<string>();
  private selectedIds = new Set<string>();
  private currentFolder: string | null = null;
  private currentCursor: string | null = null;
  private titleEdit: TitleEdit | undefined;
  private renderedLines: readonly NavigatorLine[] = [];
  private message = '';

  constructor(
    @IWorkService work: IWorkService,
    @IManuscriptService private readonly manuscript: IManuscriptService,
    @IStorageService private readonly storage: IStorageService,
    @INotificationService private readonly notifications: INotificationService,
    @IDialogService private readonly dialogs: IDialogService,
  ) {
    super();
    this.workId = work.current?.id;
    if (!this.workId) {
      return;
    }
    const saved = storage.getObject<SavedLocation>(storageKey, StorageScope.WORKSPACE);
    this.currentFolder = isManuscriptId(saved?.folderId) ? saved.folderId : null;
    this.currentCursor = saved?.cursor === UP_KEY || isManuscriptId(saved?.cursor) ? saved.cursor : null;
    for (const id of Array.isArray(saved?.expanded) ? saved.expanded : []) {
      if (isManuscriptId(id)) {
        this.expanded.add(id);
      }
    }
    this.selectedIds = new Set(Array.isArray(saved?.selected) ? saved.selected.filter(isManuscriptId) : []);
    this._register(manuscript.onDidChangeTree(workId => {
      if (workId === this.workId && !this.writePending) {
        void this.refresh();
      }
    }));
  }

  get index(): ManuscriptIndex | undefined { return this.tree?.index; }
  get revision(): number | undefined { return this.tree?.revision; }
  get folderId(): string | null { return this.currentFolder; }
  get cursor(): string | null { return this.currentCursor; }
  get selected(): ReadonlySet<string> { return this.selectedIds; }
  get lines(): readonly NavigatorLine[] { return this.renderedLines; }
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
      const dto = await this.manuscript.store.getTree(workId);
      if (this.disposed) {
        return;
      }
      const result = buildIndex(dto?.nodes);
      if (!result.ok || !isManuscriptRevision(dto?.revision)) {
        throw new Error('The manuscript tree is invalid.');
      }
      this.tree = { index: result.index, revision: dto.revision };
      this.message = '';
      if (this.currentFolder !== null && !manuscriptNodeTypes[result.index.nodes.get(this.currentFolder)?.kind ?? 'document'].container) {
        this.currentFolder = null;
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
        this.message = error instanceof Error ? error.message : 'Could not load the manuscript.';
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
      this.storage.store(storageKey, {
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

  singleSelection(): ManuscriptNode | undefined {
    if (this.selectedIds.size === 1) {
      return this.index?.nodes.get(this.selectedIds.values().next().value!);
    }
    return undefined;
  }

  enter(id: string): void {
    const node = this.index?.nodes.get(id);
    if (node && manuscriptNodeTypes[node.kind].container) {
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

  creationParent(kind: ManuscriptNodeKind, selection = this.singleSelection()): string | null | undefined {
    const allowed = manuscriptNodeTypes[kind].allowedParents;
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

  async create(kind: ManuscriptNodeKind): Promise<void> {
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

  reveal(id: string): void {
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
    this.selectedIds = new Set([id]);
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
    const suffix = manuscriptNodeTypes[node.kind].container ? ' and everything in it' : '';
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

  rename(id: string, title: string, revision: number): Promise<TreeChange | undefined> {
    return this.write((store, workId) => store.updateNode(workId, id, { title: normalizeManuscriptTitle(title, true) }, revision));
  }

  async write<T extends TreeChange>(operation: (store: ManuscriptStore, workId: string, revision: number) => Promise<T>): Promise<T | undefined> {
    if (!this.workId || this.revision === undefined || this.writePending || this.disposed) {
      return undefined;
    }
    const revision = this.revision;
    this.writePending = true;
    this.changed.fire();
    try {
      const result = await operation(this.manuscript.store, this.workId, revision);
      // A read started before this write may contain its predecessor. Follow it with a fresh read.
      await this.read;
      await this.refresh();
      return result;
    } catch (error) {
      if (error instanceof ManuscriptStoreError && error.code === 'conflict') {
        await this.read;
        await this.refresh();
        this.notifications.warn(this.message
          ? 'The manuscript changed elsewhere and could not be reloaded. Use Refresh to try again.'
          : 'The manuscript changed elsewhere. It has been reloaded.');
      } else {
        this.notifications.error(error instanceof Error ? error.message : 'Could not update the manuscript.');
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

registerSingleton(IManuscriptViewState, ManuscriptViewState);
