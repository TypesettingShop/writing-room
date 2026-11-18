import { $, addDisposableListener, append, DragAndDropObserver } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { DraggedEditorGroupIdentifier, EditorDragAndDropObserver } from '../../dnd.js';
import type { DraggedEditorItem } from '../../dnd.js';
import { GroupDirection } from '../../../services/editor/common/editorGroupsService.js';
import { mergeDroppedGroup } from './editor.js';
import type { IEditorGroupsView, IEditorGroupView } from './editor.js';
import './media/editordroptarget.css';

/**
 * Where a drop at (`x`, `y`) inside a group body of `width` x `height` goes: a split in the returned
 * direction, or `undefined` to move or merge into the group itself. Inside the centre box nothing
 * splits; the box is 10 % in from every edge for an editor, and for a group 30 % in from the sides
 * that new groups usually open on (left and right while `preferSplitVertically`), so a group is
 * harder to merge by accident. Outside it, the outer thirds split sideways and the middle third
 * splits up or down at half height (or the reverse when not `preferSplitVertically`).
 */
export function getSplitDirection(
  x: number, y: number, width: number, height: number, isDraggingGroup: boolean, preferSplitVertically: boolean,
): GroupDirection | undefined {
  const edgeWidth = width * (isDraggingGroup && preferSplitVertically ? 0.3 : 0.1);
  const edgeHeight = height * (isDraggingGroup && !preferSplitVertically ? 0.3 : 0.1);
  if (x > edgeWidth && x < width - edgeWidth && y > edgeHeight && y < height - edgeHeight) {
    return undefined;
  }
  if (preferSplitVertically) {
    if (x < width / 3) {
      return GroupDirection.LEFT;
    }
    if (x > width * 2 / 3) {
      return GroupDirection.RIGHT;
    }
    return y < height / 2 ? GroupDirection.UP : GroupDirection.DOWN;
  }
  if (y < height / 3) {
    return GroupDirection.UP;
  }
  if (y > height * 2 / 3) {
    return GroupDirection.DOWN;
  }
  return x < width / 2 ? GroupDirection.LEFT : GroupDirection.RIGHT;
}

/** Whether `item` may be dropped onto the body of `group`: never where nothing would change. */
export function isDropIntoGroupOffered(groupsView: IEditorGroupsView, group: IEditorGroupView, item: DraggedEditorItem): boolean {
  if (item instanceof DraggedEditorGroupIdentifier) {
    return item.identifier !== group.id && !!groupsView.getGroup(item.identifier);
  }
  const source = groupsView.getGroup(item.identifier.groupId);
  if (!source?.contains(item.identifier.editor)) {
    return false;
  }
  // A group's only tab would split off into a group just like the one it leaves.
  return source !== group || source.count > 1;
}

const positions: Record<GroupDirection | 'center', { readonly name: string; readonly top: string; readonly left: string; readonly width: string; readonly height: string }> = {
  [GroupDirection.UP]: { name: 'up', top: '0', left: '0', width: '100%', height: '50%' },
  [GroupDirection.DOWN]: { name: 'down', top: '50%', left: '0', width: '100%', height: '50%' },
  [GroupDirection.LEFT]: { name: 'left', top: '0', left: '0', width: '50%', height: '100%' },
  [GroupDirection.RIGHT]: { name: 'right', top: '0', left: '50%', width: '50%', height: '100%' },
  center: { name: 'center', top: '0', left: '0', width: '100%', height: '100%' },
};

/**
 * The overlay over one group's body while an editor or group is dragged over it. It sits above the
 * editor content and takes the drag events itself, so the Monaco editor below never sees the drag
 * as a text drop. Its indicator covers the half a new group would take, or the whole body.
 */
export class DropOverlay extends Disposable {
  readonly element: HTMLElement;
  private readonly indicator: HTMLElement;
  private splitDirection: GroupDirection | undefined;

  constructor(
    private readonly groupsView: IEditorGroupsView,
    readonly groupView: IEditorGroupView,
    private readonly onDidLeave: () => void,
  ) {
    super();
    this.element = $('.editor-group-overlay');
    this.element.style.top = `${groupView.titleHeight}px`;
    this.indicator = append(this.element, $('.editor-group-overlay-indicator'));
    groupView.element.append(this.element);
    this._register(toDisposable(() => this.element.remove()));

    this._register(new DragAndDropObserver(this.element, {
      // The overlay appears under a pointer that is already dragging, so its `dragenter` comes
      // first. The browser takes that event's answer as the drop operation until the next
      // `dragover`; left unanswered, a release in between would drop nothing.
      onDragEnter: event => this.onDragOver(event),
      onDragOver: event => this.onDragOver(event),
      onDragLeave: () => this.onDidLeave(),
      onDrop: event => this.drop(event),
    }));
  }

  private onDragOver(event: DragEvent): void {
    const item = EditorDragAndDropObserver.INSTANCE.getDraggedItem(event, this.element);
    if (item && isDropIntoGroupOffered(this.groupsView, this.groupView, item)) {
      this.update(event, item);
    } else {
      this.onDidLeave();
    }
  }

  /** Ends the drag and carries out the drop of `event` on this group's body, where it is offered. */
  drop(event: DragEvent): void {
    const item = EditorDragAndDropObserver.INSTANCE.getDraggedItem(event, this.element);
    const offered = !!item && isDropIntoGroupOffered(this.groupsView, this.groupView, item);
    if (offered) {
      this.update(event, item);
    }
    const splitDirection = this.splitDirection;
    event.preventDefault();
    // Whatever the drop does, the drag is over: no payload or overlay outlives it.
    EditorDragAndDropObserver.INSTANCE.endDrag();
    this.onDidLeave();
    if (offered) {
      handleDrop(this.groupsView, this.groupView, item!, splitDirection);
    }
  }

  /** Places the indicator for the pointer of `event` and accepts the drag there. */
  update(event: DragEvent, item: DraggedEditorItem): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    // Relative to the body, below the tab strip, as the grid sizes it.
    const bounds = this.groupView.element.getBoundingClientRect();
    const offset = this.groupView.titleHeight;
    this.splitDirection = getSplitDirection(
      event.clientX - bounds.left, event.clientY - bounds.top - offset, bounds.width, Math.max(0, bounds.height - offset),
      item instanceof DraggedEditorGroupIdentifier, true,
    );
    const position = positions[this.splitDirection ?? 'center'];
    Object.assign(this.indicator.style, { top: position.top, left: position.left, width: position.width, height: position.height });
    this.indicator.setAttribute('data-editor-drop-position', position.name);
  }

  contains(node: Node): boolean {
    return this.element.contains(node);
  }
}

/** Whether `node` lies in the body of `group`, below its tab strip (the overlay included). */
function isOverBody(group: IEditorGroupView, node: Node): boolean {
  return group.element.contains(node) && !group.titleContainer.contains(node);
}

/** Carries out a drop onto the body of `target`, then hands it focus with the moved editor active. */
function handleDrop(groupsView: IEditorGroupsView, target: IEditorGroupView, item: DraggedEditorItem, splitDirection: GroupDirection | undefined): void {
  let result: IEditorGroupView;
  if (item instanceof DraggedEditorGroupIdentifier) {
    const source = groupsView.getGroup(item.identifier)!;
    if (splitDirection === undefined) {
      mergeDroppedGroup(groupsView, source, target);
      result = target;
    } else {
      result = groupsView.moveGroup(source, target, splitDirection);
    }
  } else {
    const { groupId, editor } = item.identifier;
    const source = groupsView.getGroup(groupId)!;
    if (splitDirection === undefined) {
      result = target;
      if (source === target) {
        void target.openEditor(editor);
      } else {
        source.moveEditor(editor, target);
      }
    } else if (source.count === 1 && source !== target && groupsView.partOptions.closeEmptyGroups) {
      // The group would close behind its only editor anyway: move the group itself, so nothing
      // is created or torn down, as in VS Code.
      result = groupsView.moveGroup(source, target, splitDirection);
    } else {
      result = groupsView.addGroup(target, splitDirection);
      source.moveEditor(editor, result);
    }
  }
  groupsView.activateGroup(result);
  // Moving a group's element in the document drops the focus it held.
  result.focus();
}

/**
 * The editor part's drop target. Over a group body it answers only editor and group drags, by
 * showing a `DropOverlay`; every other drag (files, text, view containers) finds nothing to drop
 * on there, and Monaco never sees any drag. The tab strips handle their own drops.
 */
export class EditorDropTarget extends Disposable {
  private readonly overlayStore = this._register(new DisposableStore());
  private overlay: DropOverlay | undefined;

  constructor(
    private readonly container: HTMLElement,
    private readonly groupsView: IEditorGroupsView,
  ) {
    super();
    // Capture: the decision is made before the editor content below can take the event.
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop'] as const) {
      this._register(addDisposableListener(container, type, (event: DragEvent) => this.onDragEvent(event), true));
    }
    this._register(EditorDragAndDropObserver.INSTANCE.onDidEndDrag(() => this.disposeOverlay()));
  }

  private onDragEvent(event: DragEvent): void {
    const target = event.target as Node;
    if (this.overlay?.contains(target)) {
      return;
    }
    const item = EditorDragAndDropObserver.INSTANCE.getDraggedItem(event, this.container);
    const group = this.groupsView.groups.find(candidate => candidate.element.contains(target));
    if (!group || group.titleContainer.contains(target)) {
      // The pointer is off every body. An overlay it left before ever reaching it (the overlay
      // appears under the pointer) gets no `dragleave` of its own, so it goes here.
      if (event.type === 'dragenter' || event.type === 'dragover') {
        this.disposeOverlay();
      }
      // A tab strip offers its own drop for our drags; anything else is refused anywhere in the part.
      if (!item) {
        this.refuse(event);
      }
      return;
    }
    event.stopPropagation();
    if (event.type === 'dragleave') {
      // Out of the part straight from the body, before the overlay took the pointer.
      const next = event.relatedTarget;
      if (this.overlay?.groupView === group && next instanceof Node && !isOverBody(group, next)) {
        this.disposeOverlay();
      }
      return;
    }
    if (item && isDropIntoGroupOffered(this.groupsView, group, item)) {
      // The first event over the body puts the overlay in place; the ones after reach the overlay,
      // but a drop can still come here if the browser has not moved its target onto the overlay yet.
      if (this.overlay?.groupView !== group) {
        this.createOverlay(group);
      }
      if (event.type === 'drop') {
        this.overlay!.drop(event);
      } else {
        this.overlay!.update(event, item);
      }
      return;
    }
    if (this.overlay?.groupView === group) {
      this.disposeOverlay();
    }
    this.refuse(event);
  }

  /** Accepts the event so the browser does nothing with it (no navigation to a dropped file), and drops nothing. */
  private refuse(event: DragEvent): void {
    if (event.type === 'dragover' || event.type === 'dragenter' || event.type === 'drop') {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'none';
      }
    }
  }

  private createOverlay(group: IEditorGroupView): void {
    this.disposeOverlay();
    const overlay = this.overlay = new DropOverlay(this.groupsView, group, () => {
      if (this.overlay === overlay) {
        this.disposeOverlay();
      }
    });
    this.overlayStore.add(overlay);
    this.overlayStore.add(group.onWillDispose(() => this.disposeOverlay()));
  }

  private disposeOverlay(): void {
    this.overlay = undefined;
    this.overlayStore.clear();
  }
}

/** Sets up the part's drop target; the part disposes it with itself. */
export function createEditorDropTarget(container: HTMLElement, groupsView: IEditorGroupsView): IDisposable {
  return new EditorDropTarget(container, groupsView);
}
