import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { LocalSelectionTransfer } from '../../../../../platform/dnd/browser/dnd.js';
import { ExtensionTreeViews } from '../../../../api/browser/mainThreadTreeViews.js';
import type { TreeDataSource } from '../../../../api/browser/mainThreadTreeViews.js';
import type { TreeViewOptionsDto } from '../../../../api/common/extHost.protocol.js';
import {
  CompositeDragAndDropObserver, DraggedCompositeIdentifier, DraggedEditorIdentifier, DraggedTreeItems, EditorDragAndDropObserver,
  isWorkbenchDrag, TreeDragAndDropObserver,
} from '../../../../browser/dnd.js';
import { TreeViewDragAndDrop } from '../../../../browser/parts/views/treeViewDragAndDrop.js';

function transfer(types: string[] = []) {
  return {
    types, items: [] as { kind: string; type: string }[], files: [] as File[],
    effectAllowed: 'none', dropEffect: 'none',
    setData(type: string) { this.types.push(type); },
    getData() { return ''; },
  };
}

function dispatch(element: EventTarget, type: string, dataTransfer?: ReturnType<typeof transfer>, init: KeyboardEventInit = {}) {
  const event = Object.assign(type === 'keydown' ? new KeyboardEvent(type, { bubbles: true, ...init }) : new Event(type, { bubbles: true, cancelable: true }), { dataTransfer });
  element.dispatchEvent(event);
  return event;
}

const options = (change: Partial<TreeViewOptionsDto> = {}): TreeViewOptionsDto => ({
  showCollapseAll: false, canSelectMany: false, manageCheckboxStateManually: false,
  dropMimeTypes: ['text/plain'], dragMimeTypes: ['application/vnd.test'], hasHandleDrag: true, hasHandleDrop: true, ...change,
});

let disposables: DisposableStore;
let views: ExtensionTreeViews;
let tokens: CancellationToken[];
let released: string[];
let drops: unknown[][];

function register(view: string, extension: string, change?: Partial<TreeViewOptionsDto>): TreeDataSource {
  const source: TreeDataSource = {
    extension, options: options(change), onDidRefresh: new Emitter<readonly string[] | undefined>().event,
    getItem: async () => undefined, getChildren: async () => [],
    reference: handle => ({ kind: 'extensionTreeItem', extension, view, handle }),
    handleDrag: async (_handles, _drag, token) => {
      tokens.push(token);
      return [{ mimeType: 'application/vnd.test', value: 'payload' }];
    },
    handleDrop: async (...args) => void drops.push(args.slice(0, 3)),
    releaseDrag: drag => void released.push(drag),
  };
  disposables.add(views.register(view, source));
  return source;
}

function pane(view: string) {
  const content = document.createElement('div');
  const row = document.createElement('div');
  row.setAttribute('role', 'treeitem');
  content.append(row);
  document.body.append(content);
  disposables.add(toDisposable(() => content.remove()));
  const dnd = disposables.add(new TreeViewDragAndDrop(view, content, views,
    target => target instanceof Element && target.closest('[role="treeitem"]') ? { handle: 'row', row } : undefined,
    handle => [handle]));
  dnd.makeDraggable(row, 'row');
  return { content, row, dnd };
}

beforeEach(() => {
  disposables = new DisposableStore();
  views = disposables.add(new ExtensionTreeViews());
  tokens = [];
  released = [];
  drops = [];
});

afterEach(() => {
  TreeDragAndDropObserver.INSTANCE.endDrag(false);
  EditorDragAndDropObserver.INSTANCE.endDrag();
  disposables.dispose();
});

test.each(['Escape', 'pagehide'])('%s ends a tree drag, clearing its mark, payload and host value', end => {
  register('tree', 'e');
  const { row, content } = pane('tree');
  const data = transfer();
  dispatch(row, 'dragstart', data);
  expect(data.types).toEqual(['application/x-writing-room-tree', 'application/vnd.code.tree.tree', 'application/vnd.test']);
  expect(LocalSelectionTransfer.getInstance().hasData(DraggedTreeItems.prototype)).toBe(true);
  dispatch(row, 'dragenter', data);
  expect(dispatch(row, 'dragover', data).defaultPrevented).toBe(true);
  expect(row.classList.contains('drop-target')).toBe(true);

  if (end === 'Escape') {
    dispatch(window, 'keydown', undefined, { key: 'Escape' });
  } else {
    dispatch(window, end);
  }
  expect(row.classList.contains('drop-target')).toBe(false);
  expect(LocalSelectionTransfer.getInstance().hasData(DraggedTreeItems.prototype)).toBe(false);
  expect(tokens[0].isCancellationRequested).toBe(true);
  expect(released).toEqual([expect.stringMatching(/^tree:/)]);
  // What is left of the drag is no longer the tree's.
  expect(dispatch(content, 'dragover', data).defaultPrevented).toBe(false);
  expect(TreeDragAndDropObserver.INSTANCE.getDraggedItem(data as unknown as DragEvent, content)).toBeUndefined();
});

test('window blur preserves a tree drag and its source values through drop', async () => {
  register('source', 'e');
  register('target', 'e', { dropMimeTypes: ['application/vnd.test'] });
  const from = pane('source');
  const to = pane('target');
  const data = transfer();
  dispatch(from.row, 'dragstart', data);
  expect(dispatch(to.row, 'dragover', data).defaultPrevented).toBe(true);

  window.dispatchEvent(new Event('blur'));
  data.dropEffect = 'none';
  expect(dispatch(to.row, 'dragover', data).defaultPrevented).toBe(true);
  expect(data.dropEffect).toBe('copy');
  expect(dispatch(to.row, 'drop', data).defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(drops).toHaveLength(1));
  expect(drops[0]).toEqual(['row', [
    { mimeType: 'application/vnd.code.tree.source', value: JSON.stringify({ id: 'source', itemHandles: ['row'] }) },
    { mimeType: 'application/vnd.test', value: 'payload' },
  ], expect.stringMatching(/^source:/)]);
  expect(tokens[0].isCancellationRequested).toBe(false);
  expect(released).toEqual([drops[0][2]]);
});

test('the editor and view container targets do not take a tree drag, and a tree does not take theirs', () => {
  register('tree', 'e');
  const { row, content } = pane('tree');
  const target = document.createElement('div');
  document.body.append(target);
  disposables.add(toDisposable(() => target.remove()));
  const onDragOver = vi.fn(() => true);
  disposables.add(CompositeDragAndDropObserver.INSTANCE.registerTarget(target, { onDragOver, onDrop() {}, onDragLeave() {} }));

  const data = transfer();
  dispatch(row, 'dragstart', data);
  dispatch(target, 'dragover', data);
  expect(onDragOver).not.toHaveBeenCalled();
  expect(EditorDragAndDropObserver.INSTANCE.getDraggedItem(data as unknown as DragEvent, target)).toBeUndefined();
  dispatch(row, 'dragend', data);

  // An editor tab drag carries text the tree takes from outside, but it is the workbench's own.
  const tab = document.createElement('div');
  document.body.append(tab);
  disposables.add(toDisposable(() => tab.remove()));
  const editorData = transfer();
  EditorDragAndDropObserver.INSTANCE.startDrag(Object.assign(new Event('dragstart'), { dataTransfer: editorData }) as unknown as DragEvent,
    tab, new DraggedEditorIdentifier({ groupId: 1, editor: {} as never }), 'Welcome');
  expect(editorData.types).toContain('text/plain');
  expect(isWorkbenchDrag({ dataTransfer: editorData } as unknown as DragEvent)).toBe(true);
  expect(dispatch(content, 'dragover', editorData).defaultPrevented).toBe(false);
  dispatch(content, 'drop', editorData);
  EditorDragAndDropObserver.INSTANCE.endDrag();
  // Even without the marker, a view container drag in progress is not taken.
  const container = document.createElement('button');
  document.body.append(container);
  disposables.add(toDisposable(() => container.remove()));
  disposables.add(CompositeDragAndDropObserver.INSTANCE.registerDraggable(container, () => new DraggedCompositeIdentifier('explorer')));
  dispatch(container, 'dragstart', transfer());
  expect(dispatch(content, 'dragover', transfer(['text/plain'])).defaultPrevented).toBe(false);
  dispatch(container, 'dragend', transfer());
  // Plain text from outside the window is taken.
  expect(dispatch(content, 'dragover', transfer(['text/plain'])).defaultPrevented).toBe(true);
  expect(drops).toEqual([]);
});

test('a drag ends when its tree loses its provider, as when the extension is removed', () => {
  const registration = views.register('tree', register('other', 'e'));
  const { row, dnd } = pane('tree');
  dispatch(row, 'dragstart', transfer());
  expect(LocalSelectionTransfer.getInstance().hasData(DraggedTreeItems.prototype)).toBe(true);
  registration.dispose();
  dnd.sourceChanged();
  expect(LocalSelectionTransfer.getInstance().hasData(DraggedTreeItems.prototype)).toBe(false);
  expect(released).toHaveLength(1);
});
