import { isEqual, isEqualOrParent, joinPath, relativePath } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';

/** How many entries of one folder the Explorer shows; the rest are counted in a "more" row. */
export const MAX_EXPLORER_CHILDREN = 10_000;

/** One entry of a folder as the file service lists it. */
export interface IExplorerChildStat {
  readonly name: string;
  readonly isDirectory: boolean;
}

const numericCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * VS Code's default file name order (`compareFileNamesDefault`): the whole name with a numeric,
 * case- and accent-insensitive collator, so `file2` comes before `file10` and `a` beside `B`. Names
 * the collator finds equal go shorter first, then by code unit, so the order is total.
 */
export function compareFileNames(one: string, other: string): number {
  const result = numericCollator.compare(one, other);
  if (result !== 0) {
    return result;
  }
  if (one.length !== other.length) {
    return one.length < other.length ? -1 : 1;
  }
  return one === other ? 0 : one < other ? -1 : 1;
}

/** Folders first, then files, each by `compareFileNames` (VS Code's `explorer.sortOrder: default`). */
export function compareExplorerItems(one: IExplorerChildStat, other: IExplorerChildStat): number {
  if (one.isDirectory !== other.isDirectory) {
    return one.isDirectory ? -1 : 1;
  }
  return compareFileNames(one.name, other.name);
}

/**
 * A file or folder of the Explorer. A folder's children are read when it is expanded: until then,
 * and again after a change it was not visible for, `children` is `undefined`.
 */
export class ExplorerItem {
  private _children: ExplorerItem[] | undefined;
  private byName = new Map<string, ExplorerItem>();

  constructor(
    readonly resource: URI,
    readonly parent: ExplorerItem | undefined,
    readonly isDirectory: boolean,
    readonly name: string,
  ) {}

  get isRoot(): boolean {
    return this.parent === undefined;
  }

  /** Every child, sorted; `undefined` while the folder has not been read. */
  get children(): readonly ExplorerItem[] | undefined {
    return this._children;
  }

  get isResolved(): boolean {
    return this._children !== undefined;
  }

  /** The children the tree shows: the first `MAX_EXPLORER_CHILDREN`. */
  get visibleChildren(): readonly ExplorerItem[] {
    const children = this._children ?? [];
    return children.length > MAX_EXPLORER_CHILDREN ? children.slice(0, MAX_EXPLORER_CHILDREN) : children;
  }

  /** How many children the tree leaves out. */
  get hiddenChildCount(): number {
    return Math.max(0, (this._children?.length ?? 0) - MAX_EXPLORER_CHILDREN);
  }

  /** Nesting below the root: the root's children are at depth 1. */
  get depth(): number {
    let depth = 0;
    for (let item = this.parent; item; item = item.parent) {
      depth++;
    }
    return depth;
  }

  /** Whether this item is still part of its model: its parent still lists it. */
  get isAttached(): boolean {
    for (let item: ExplorerItem = this; item.parent; item = item.parent) {
      if (item.parent.byName.get(item.name) !== item) {
        return false;
      }
    }
    return true;
  }

  getChild(name: string): ExplorerItem | undefined {
    return this.byName.get(name);
  }

  /**
   * Takes the folder's listing. A child that is still there with the same kind keeps its item, and
   * with it what was read below it; the others are made anew. Gives the items that went away.
   */
  setChildren(stats: readonly IExplorerChildStat[]): ExplorerItem[] {
    const previous = this.byName;
    const next = new Map<string, ExplorerItem>();
    for (const stat of stats) {
      const existing = previous.get(stat.name);
      next.set(stat.name, existing && existing.isDirectory === stat.isDirectory
        ? existing
        : new ExplorerItem(joinPath(this.resource, stat.name), this, stat.isDirectory, stat.name));
    }
    const removed = [...previous.values()].filter(item => next.get(item.name) !== item);
    this.byName = next;
    this._children = [...next.values()].sort(compareExplorerItems);
    return removed;
  }

  /** Drops what was read, so the folder is read again when it is next shown. */
  forget(): void {
    this._children = undefined;
    this.byName = new Map();
  }
}

/** The Explorer's tree: one workspace folder as its root, read folder by folder. */
export class ExplorerModel {
  readonly root: ExplorerItem;

  constructor(rootResource: URI, rootName: string) {
    this.root = new ExplorerItem(rootResource, undefined, true, rootName);
  }

  /** The item of `resource`, if every folder above it has been read. */
  find(resource: URI): ExplorerItem | undefined {
    if (isEqual(resource, this.root.resource)) {
      return this.root;
    }
    const segments = this.segments(resource);
    let item: ExplorerItem | undefined = this.root;
    for (const segment of segments ?? []) {
      item = item?.getChild(segment);
    }
    return segments ? item : undefined;
  }

  /** The names from the root down to `resource`, or `undefined` when it is not inside the root. */
  segments(resource: URI): string[] | undefined {
    if (!isEqualOrParent(resource, this.root.resource)) {
      return undefined;
    }
    const relative = relativePath(this.root.resource, resource);
    return relative ? relative.split('/').filter(Boolean) : [];
  }
}
