import { addDisposableListener, DragAndDropObserver } from '../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import type { DraggedNavigatorItems, NavigatorDragAndDropObserver } from '../dnd.js';
import {
  dropPositionAt, resolveDrop, type DropPosition, type NavigatorIndex, type NavigatorLine, type NavigatorNode,
} from '../../common/navigator/navigatorTree.js';
import type { NavigatorStore, NavigatorViewState } from './navigatorViewState.js';

export const NAVIGATOR_ROW_HEIGHT = 24;
const expandAfter = 700;
const scrollEdge = 32;
type Drop = Extract<ReturnType<typeof resolveDrop>, { ok: true }>;

export interface NavigatorDragOptions {
  readonly observer: NavigatorDragAndDropObserver;
  readonly dropDatasetKey: string;
}

interface DropSuggestion<N extends NavigatorNode> {
  readonly line: NavigatorLine<N> | undefined;
  readonly position: DropPosition;
  readonly result: ReturnType<typeof resolveDrop>;
}

export class NavigatorDrag<N extends NavigatorNode, S extends NavigatorStore<N>> extends Disposable {
  private readonly window: Window;
  private readonly rowSelector: string;
  private pointer: { readonly y: number; readonly drag: DraggedNavigatorItems } | undefined;
  private marker: { readonly key: string | undefined; readonly position: DropPosition } | undefined;
  private expandTimer: number | undefined;
  private expanding: string | undefined;
  private scrollFrame: number | undefined;

  constructor(
    private readonly tree: HTMLElement,
    private readonly state: NavigatorViewState<N, S>,
    private readonly cssPrefix: string,
    private readonly options: NavigatorDragOptions,
    private readonly rowElement: (key: string) => HTMLElement | undefined,
    private readonly redraw: () => void,
    @INotificationService private readonly notifications: INotificationService,
  ) {
    super();
    this.window = tree.ownerDocument.defaultView!;
    this.rowSelector = `.${cssPrefix}-row[draggable="true"]`;
    this._register(addDisposableListener(tree, 'dragstart', event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(this.rowSelector);
      const id = row?.dataset.key;
      if (!row || !id) {
        return;
      }
      if (!state.workId || state.editing) {
        // A row drag without a work session would carry nothing any target can take.
        event.preventDefault();
        return;
      }
      const nodeIds = state.selected.has(id) ? [...state.selected] : [id];
      this.options.observer.startDrag(event, row, { workId: state.workId, nodeIds });
    }));
    // The browser can release before the next dragover, so entering each row is answered too,
    // not only entering the tree: the pointer may have moved from a refused row to an allowed one.
    this._register(addDisposableListener(tree, 'dragenter', event => this.hover(event)));
    const target = this._register(new DragAndDropObserver(tree, {
      onDragOver: event => this.hover(event),
      onDragLeave: () => this.clear(),
      onDrop: event => this.drop(event),
    }));
    this._register(this.options.observer.onDidEndDrag(() => {
      target.reset();
      this.clear();
      redraw();
    }));
    this._register(toDisposable(() => {
      this.clear();
      for (const row of tree.querySelectorAll<HTMLElement>(this.rowSelector)) {
        if (this.options.observer.isSource(row)) {
          this.options.observer.endDrag();
          break;
        }
      }
    }));
  }

  isSource(row: HTMLElement): boolean {
    return this.options.observer.isSource(row);
  }

  markRow(row: HTMLElement, key: string): void {
    if (this.marker?.key === key) {
      row.dataset[this.options.dropDatasetKey] = this.marker.position;
    } else {
      delete row.dataset[this.options.dropDatasetKey];
    }
  }

  private suggestion(y: number, drag: DraggedNavigatorItems): DropSuggestion<N> | undefined {
    const { index, workId, lines, folderId } = this.state;
    if (!index || drag.workId !== workId || this.state.busy) {
      return undefined;
    }
    const offset = y - this.tree.getBoundingClientRect().top + this.tree.scrollTop;
    const line = lines[Math.floor(offset / NAVIGATOR_ROW_HEIGHT)];
    const into = resolveDrop(drag.nodeIds, line, 'into', folderId, index);
    const position = line?.kind === 'node' ? dropPositionAt(offset % NAVIGATOR_ROW_HEIGHT, NAVIGATOR_ROW_HEIGHT, into.ok) : 'into';
    return { line, position, result: position === 'into' ? into : resolveDrop(drag.nodeIds, line, position, folderId, index) };
  }

  private hover(event: DragEvent): void {
    const drag = this.options.observer.getDraggedItems(event, this.tree);
    if (!drag || drag.workId !== this.state.workId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.pointer = { y: event.clientY, drag };
    const accepted = this.updateSuggestion();
    event.dataTransfer!.dropEffect = accepted ? 'move' : 'none';
    this.scheduleScroll();
  }

  private updateSuggestion(): boolean {
    const pointer = this.pointer;
    const suggestion = pointer && this.suggestion(pointer.y, pointer.drag);
    let expandKey: string | undefined;
    if (suggestion?.result.ok && suggestion.position === 'into' && suggestion.line?.kind === 'node' &&
        suggestion.line.dir && !suggestion.line.open) {
      expandKey = suggestion.line.key;
    }
    this.setExpandTimer(expandKey);
    this.setMarker(suggestion?.result.ok ? { key: suggestion.line?.key, position: suggestion.position } : undefined);
    return !!suggestion?.result.ok;
  }

  private setMarker(marker: typeof this.marker): void {
    const previous = this.marker?.key;
    this.marker = marker;
    if (previous !== undefined) {
      const row = this.rowElement(previous);
      if (row) {
        this.markRow(row, previous);
      }
    }
    if (marker?.key !== undefined) {
      const row = this.rowElement(marker.key);
      if (row) {
        this.markRow(row, marker.key);
      }
    }
    this.tree.classList.toggle(`${this.cssPrefix}-drop-end`, !!marker && marker.key === undefined);
  }

  private setExpandTimer(key: string | undefined): void {
    if (key === this.expanding) {
      return;
    }
    if (this.expandTimer !== undefined) {
      this.window.clearTimeout(this.expandTimer);
      this.expandTimer = undefined;
    }
    this.expanding = key;
    if (key !== undefined) {
      this.expandTimer = this.window.setTimeout(() => {
        this.expandTimer = undefined;
        const folder = this.state.lines.find(line => line.key === key);
        if (folder?.kind === 'node' && folder.dir && !folder.open) {
          this.state.toggle(key);
          this.updateSuggestion();
        }
      }, expandAfter);
    }
  }

  private scheduleScroll(): void {
    if (this.scrollFrame !== undefined || !this.pointer) {
      return;
    }
    const { top, bottom } = this.tree.getBoundingClientRect();
    const { y } = this.pointer;
    const step = y < top + scrollEdge ? -8 : y > bottom - scrollEdge ? 8 : 0;
    if (!step) {
      return;
    }
    this.scrollFrame = this.window.requestAnimationFrame(() => {
      this.scrollFrame = undefined;
      const before = this.tree.scrollTop;
      this.tree.scrollTop += step;
      if (this.tree.scrollTop !== before && this.pointer) {
        this.updateSuggestion();
        this.redraw();
        this.scheduleScroll();
      }
    });
  }

  private drop(event: DragEvent): void {
    const drag = this.options.observer.getDraggedItems(event, this.tree);
    if (!drag || drag.workId !== this.state.workId) {
      return;
    }
    const suggestion = this.suggestion(event.clientY, drag);
    event.preventDefault();
    event.stopPropagation();
    this.options.observer.endDrag();
    if (suggestion) {
      const { result } = suggestion;
      if (result.ok) {
        void move(this.state, result);
      } else {
        this.notifications.info(result.reason);
      }
    }
  }

  private clear(): void {
    this.pointer = undefined;
    this.setMarker(undefined);
    this.setExpandTimer(undefined);
    if (this.scrollFrame !== undefined) {
      this.window.cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = undefined;
    }
  }
}

function wouldChangeOrder(drop: Drop, index: NavigatorIndex): boolean {
  const { destination, sourceIds } = drop;
  if (sourceIds.some(id => index.nodes.get(id)?.parentId !== destination.parentId)) {
    return true;
  }
  const siblings = index.children.get(destination.parentId) ?? [];
  const selected = new Set(sourceIds);
  const remaining = siblings.filter(node => !selected.has(node.id));
  const insertion = destination.beforeId === undefined ? remaining.length : remaining.findIndex(node => node.id === destination.beforeId);
  return sourceIds.some((id, position) => siblings[insertion + position]?.id !== id);
}

async function move<N extends NavigatorNode, S extends NavigatorStore<N>>(state: NavigatorViewState<N, S>, drop: Drop): Promise<void> {
  if (state.index && wouldChangeOrder(drop, state.index)) {
    const result = await state.write((store, workId, revision) => store.moveNodes(workId, drop.sourceIds, drop.destination, revision));
    if (result) {
      state.reveal(drop.sourceIds[0], drop.sourceIds);
    }
  }
}

export async function moveAdjacent<N extends NavigatorNode, S extends NavigatorStore<N>>(
  state: NavigatorViewState<N, S>, delta: -1 | 1,
): Promise<void> {
  const node = state.singleSelection();
  const index = state.index;
  if (!node || !index) {
    return;
  }
  const other = index.children.get(node.parentId)?.[node.position + delta];
  if (other) {
    const result = resolveDrop([node.id], { kind: 'node', key: other.id }, delta === -1 ? 'before' : 'after', node.parentId, index);
    if (result.ok) {
      await move(state, result);
    }
  }
}
