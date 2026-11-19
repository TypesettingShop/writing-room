import { Emitter } from '../../../../base/common/event.js';
import type { Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, isEqual, isEqualOrParent, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import {
  FileChangeType, FileOperationError, FileOperationResult, FileSystemProviderErrorCode, IFileService,
  toFileSystemProviderErrorCode,
} from '../../../../platform/files/common/files.js';
import type { FileChangesEvent } from '../../../../platform/files/common/files.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { NotificationsToasts } from '../../../browser/parts/notifications/notificationsToasts.js';
import { ExplorerModel } from '../common/explorerModel.js';
import type { ExplorerItem } from '../common/explorerModel.js';

/** VS Code's key for the Explorer tree's state, in the workspace scope. */
export const EXPLORER_VIEW_STATE_KEY = 'workbench.explorer.treeViewState';

/** How many expanded folders the stored state keeps; more are dropped, deepest last. */
const MAX_STORED_EXPANDED = 10_000;

/** What the inline input of the tree is for: a new entry in `item` (a folder), or a new name for `item`. */
export interface IExplorerEditable {
  readonly kind: 'newFile' | 'newFolder' | 'rename';
  readonly item: ExplorerItem;
  /** Why the typed name cannot be taken, or `undefined` when it can. */
  validate(value: string): string | undefined;
  /** The input closed: with the name to take, or cancelled. */
  onFinish(value: string, committed: boolean): void;
}

export interface IExplorerRevealEvent {
  readonly item: ExplorerItem;
  /** Move the keyboard focus to the item, not only select it and scroll it into view. */
  readonly focus: boolean;
}

/** The Explorer's view, as the service drives it. */
export interface IExplorerView {
  focus(): void;
}

export const IExplorerService = createDecorator<IExplorerService>('explorerService');

/**
 * The Explorer's model and state, as VS Code's `IExplorerService`: the workspace folder read folder by
 * folder, which folders are expanded (kept in the workspace storage), the selected item, and the item
 * the inline input edits. It follows the file service's changes, re-reading the folders on screen.
 */
export interface IExplorerService extends BrandedService {
  /** The model, its expansion, selection or inline input changed. */
  readonly onDidChange: Event<void>;
  readonly onDidRequestReveal: Event<IExplorerRevealEvent>;
  readonly root: ExplorerItem;
  /** The selected item, which is also the tree's focused one. */
  readonly selection: ExplorerItem | undefined;
  readonly editable: IExplorerEditable | undefined;
  /** Whether a view shows the tree. */
  readonly hasView: boolean;

  find(resource: URI): ExplorerItem | undefined;
  isExpanded(item: ExplorerItem): boolean;
  /** Expands or collapses a folder; an expanded folder is read when it has not been. */
  setExpanded(item: ExplorerItem, expanded: boolean): Promise<void>;
  collapseAll(): void;
  /** Reads every folder on screen again and forgets the others. */
  refresh(): Promise<void>;
  /** Reads `item`, a folder, again; the promise settles once the latest read of it has been taken. */
  resolveFolder(item: ExplorerItem): Promise<void>;
  setSelection(item: ExplorerItem | undefined): void;
  /**
   * Expands the folders above `resource`, selects it and scrolls it into view. Resolves to whether
   * it was found; a later call wins over one still reading.
   */
  select(resource: URI, options?: { readonly focus?: boolean }): Promise<boolean>;
  setEditable(editable: IExplorerEditable | undefined): void;
  /** Gives the old paths below `from`, expanded, their places below `to`. */
  moveExpanded(from: URI, to: URI): void;
  registerView(view: IExplorerView): IDisposable;
  focusView(): void;
  showError(message: string): void;
}

export class ExplorerService extends Disposable implements IExplorerService {
  declare readonly _serviceBrand: undefined;

  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly revealRequested = this._register(new Emitter<IExplorerRevealEvent>());
  readonly onDidRequestReveal = this.revealRequested.event;

  private readonly model: ExplorerModel;
  /** The expanded folders below the root, as URI strings. */
  private readonly expanded = new Set<string>();
  /** The latest read of each folder and its number: an older read that ends later is dropped. */
  private readonly reads = new Map<ExplorerItem, { readonly generation: number; readonly done: Promise<void> }>();
  private generation = 0;
  private selectRequest = 0;
  private selected: ExplorerItem | undefined;
  private _editable: IExplorerEditable | undefined;
  private view: IExplorerView | undefined;
  private toasts: NotificationsToasts | undefined;

  constructor(
    @IFileService private readonly fileService: IFileService,
    @IWorkspaceContextService workspace: IWorkspaceContextService,
    @IStorageService private readonly storage: IStorageService,
    @IInstantiationService private readonly instantiationService: IInstantiationService,
  ) {
    super();
    const folder = workspace.getWorkspace().folders[0];
    this.model = new ExplorerModel(folder.uri, folder.name);
    this.readExpanded();
    this._register(fileService.onDidFilesChange(event => this.onFilesChange(event)));
    void this.resolveFolder(this.model.root);
  }

  get root(): ExplorerItem {
    return this.model.root;
  }

  get selection(): ExplorerItem | undefined {
    return this.selected?.isAttached ? this.selected : undefined;
  }

  get editable(): IExplorerEditable | undefined {
    return this._editable;
  }

  get hasView(): boolean {
    return this.view !== undefined;
  }

  find(resource: URI): ExplorerItem | undefined {
    return this.model.find(resource);
  }

  isExpanded(item: ExplorerItem): boolean {
    return item.isRoot || this.expanded.has(item.resource.toString());
  }

  async setExpanded(item: ExplorerItem, expanded: boolean): Promise<void> {
    if (item.isRoot) {
      // The root is always expanded; it may still be on its first read.
      await this.ensureResolved(item);
      return;
    }
    if (!item.isDirectory) {
      return;
    }
    if (expanded !== this.isExpanded(item)) {
      if (expanded) {
        this.expanded.add(item.resource.toString());
      } else {
        this.expanded.delete(item.resource.toString());
      }
      this.storeExpanded();
      this.changed.fire();
    }
    if (expanded) {
      await this.ensureResolved(item);
    }
  }

  collapseAll(): void {
    if (this.expanded.size) {
      this.expanded.clear();
      this.storeExpanded();
      this.changed.fire();
    }
  }

  async refresh(): Promise<void> {
    const reads: Promise<void>[] = [];
    const visit = (item: ExplorerItem) => {
      if (!item.isResolved) {
        return;
      }
      if (this.isVisibleFolder(item)) {
        reads.push(this.resolveFolder(item));
        item.children?.filter(child => child.isDirectory).forEach(visit);
      } else {
        this.forget(item);
      }
    };
    visit(this.model.root);
    if (!reads.length) {
      reads.push(this.resolveFolder(this.model.root));
    }
    this.changed.fire();
    await Promise.all(reads);
  }

  resolveFolder(item: ExplorerItem): Promise<void> {
    const generation = ++this.generation;
    const done = this.read(item, generation).finally(() => {
      if (this.reads.get(item)?.generation === generation) {
        this.reads.delete(item);
      }
    });
    this.reads.set(item, { generation, done });
    return done;
  }

  setSelection(item: ExplorerItem | undefined): void {
    if (item !== this.selected) {
      this.selected = item;
      this.changed.fire();
    }
  }

  async select(resource: URI, options?: { readonly focus?: boolean }): Promise<boolean> {
    const request = ++this.selectRequest;
    const segments = this.model.segments(resource);
    if (!segments) {
      return false;
    }
    let item = this.model.root;
    let expandedAny = false;
    for (const [index, segment] of segments.entries()) {
      if (!item.isResolved) {
        await this.ensureResolved(item);
      }
      if (request !== this.selectRequest) {
        return false;
      }
      const child = item.getChild(segment);
      if (!child) {
        return false;
      }
      if (index < segments.length - 1) {
        if (!child.isDirectory) {
          return false;
        }
        if (!this.isExpanded(child)) {
          this.expanded.add(child.resource.toString());
          expandedAny = true;
        }
      }
      item = child;
    }
    if (expandedAny) {
      this.storeExpanded();
    }
    this.selected = item;
    this.changed.fire();
    this.revealRequested.fire({ item, focus: options?.focus ?? false });
    return true;
  }

  setEditable(editable: IExplorerEditable | undefined): void {
    if (editable !== this._editable) {
      this._editable = editable;
      this.changed.fire();
    }
  }

  moveExpanded(from: URI, to: URI): void {
    let moved = false;
    for (const key of [...this.expanded]) {
      const resource = URI.parse(key);
      const relative = isEqualOrParent(resource, from) ? relativePath(from, resource) : undefined;
      if (relative !== undefined) {
        this.expanded.delete(key);
        this.expanded.add((relative ? URI.joinPath(to, relative) : to).toString());
        moved = true;
      }
    }
    if (moved) {
      this.storeExpanded();
    }
  }

  registerView(view: IExplorerView): IDisposable {
    this.view = view;
    return toDisposable(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  focusView(): void {
    this.view?.focus();
  }

  showError(message: string): void {
    this.toasts ??= this._register(new NotificationsToasts(
      this.instantiationService.invokeFunction(accessor => accessor.get(ILayoutService)).mainContainer,
    ));
    this.toasts.show('error', message, [], () => {});
  }

  /** Waits for the folder's latest read, starting one when there is none. */
  private async ensureResolved(item: ExplorerItem): Promise<void> {
    for (let attempt = 0; attempt < 3 && !item.isResolved && item.isAttached; attempt++) {
      await (this.reads.get(item)?.done ?? this.resolveFolder(item));
    }
  }

  private async read(item: ExplorerItem, generation: number): Promise<void> {
    let children: { name: string; isDirectory: boolean }[];
    try {
      const stat = await this.fileService.resolve(item.resource);
      children = (stat.children ?? []).map(child => ({ name: child.name, isDirectory: child.isDirectory }));
    } catch (error) {
      if (!isNotFound(error)) {
        console.warn(`Explorer could not read ${item.resource}.`, error);
      }
      // A folder that is gone (or not made yet: the workspace folder at the first start) is empty.
      children = [];
    }
    if (this.reads.get(item)?.generation !== generation || !item.isAttached) {
      return;
    }
    const removed = item.setChildren(children);
    let prunedExpansion = false;
    for (const gone of removed) {
      prunedExpansion = this.dropExpanded(gone.resource) || prunedExpansion;
      if (this.selected && isEqualOrParent(this.selected.resource, gone.resource)) {
        this.selected = undefined;
      }
    }
    if (prunedExpansion) {
      this.storeExpanded();
    }
    this.changed.fire();
    // Expanded folders below are read too, so a restored tree opens as it was.
    for (const child of item.children ?? []) {
      if (child.isDirectory && this.isExpanded(child) && !child.isResolved && !this.reads.has(child)) {
        void this.resolveFolder(child);
      }
    }
  }

  /**
   * A change re-reads the folder it happened in when that folder is on screen. A folder that has been
   * read but is collapsed (or below a collapsed one) forgets its listing and is read when shown.
   */
  private onFilesChange(event: FileChangesEvent): void {
    const folders = new Set<ExplorerItem>();
    for (const change of event.changes) {
      if (change.type === FileChangeType.UPDATED || !isEqualOrParent(change.resource, this.model.root.resource)) {
        continue;
      }
      const folder = isEqual(change.resource, this.model.root.resource)
        ? this.model.root
        : this.model.find(dirname(change.resource));
      if (!folder?.isResolved) {
        continue;
      }
      if (this.isVisibleFolder(folder)) {
        folders.add(folder);
      } else {
        this.forget(folder);
      }
    }
    for (const folder of folders) {
      void this.resolveFolder(folder);
    }
  }

  /** Drops a folder's listing and any read of it still on its way, which may predate the change. */
  private forget(item: ExplorerItem): void {
    item.forget();
    this.reads.delete(item);
  }

  private isVisibleFolder(item: ExplorerItem): boolean {
    for (let current: ExplorerItem | undefined = item; current; current = current.parent) {
      if (!this.isExpanded(current)) {
        return false;
      }
    }
    return true;
  }

  private dropExpanded(resource: URI): boolean {
    let dropped = false;
    for (const key of [...this.expanded]) {
      if (isEqualOrParent(URI.parse(key), resource)) {
        this.expanded.delete(key);
        dropped = true;
      }
    }
    return dropped;
  }

  /** Reads the stored expansion; a stored value that is not a list of folders below the root is ignored. */
  private readExpanded(): void {
    const raw = this.storage.get(EXPLORER_VIEW_STATE_KEY, StorageScope.WORKSPACE);
    if (raw === undefined) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    const list = typeof value === 'object' && value !== null ? (value as { expanded?: unknown }).expanded : undefined;
    if (!Array.isArray(list)) {
      return;
    }
    for (const entry of list.slice(0, MAX_STORED_EXPANDED)) {
      if (typeof entry !== 'string') {
        continue;
      }
      let resource: URI;
      try {
        resource = URI.parse(entry, true);
      } catch {
        continue;
      }
      if (!isEqual(resource, this.model.root.resource) && this.model.segments(resource)?.length) {
        this.expanded.add(resource.toString());
      }
    }
  }

  private storeExpanded(): void {
    const expanded = [...this.expanded].slice(0, MAX_STORED_EXPANDED);
    this.storage.store(EXPLORER_VIEW_STATE_KEY, JSON.stringify({ expanded }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
  }
}

function isNotFound(error: unknown): boolean {
  return toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound
    || (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND);
}

registerSingleton(IExplorerService, ExplorerService);
