import { afterEach, expect, test, vi } from 'vitest';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { MenuId, type IMenuService } from '../../../../platform/actions/common/actions.js';
import type { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { IContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { InMemoryStorageService } from '../../../../platform/storage/common/storage.js';
import { CharactersDragAndDropObserver, ManuscriptDragAndDropObserver, WorldDragAndDropObserver, isWorkbenchDrag } from '../../../browser/dnd.js';
import { NavigatorView } from '../../../browser/navigator/navigatorView.js';
import { NavigatorViewState, type NavigatorStore } from '../../../browser/navigator/navigatorViewState.js';
import type { NavigatorNode } from '../../../common/navigator/navigatorTree.js';

interface ExampleNode extends NavigatorNode {
  readonly kind: 'folder' | 'item';
  readonly status?: 'unread' | 'read';
}

const folder: ExampleNode = { id: 'folder', parentId: null, kind: 'folder', title: 'Folder', position: 0 };
const child: ExampleNode = { id: 'child', parentId: folder.id, kind: 'item', title: 'Child', position: 0 };
const loose: ExampleNode = { id: 'loose', parentId: null, kind: 'item', title: 'Note', position: 1, status: 'unread' };
const disposables = new DisposableStore();

afterEach(() => {
  CharactersDragAndDropObserver.INSTANCE.endDrag();
  ManuscriptDragAndDropObserver.INSTANCE.endDrag();
  WorldDragAndDropObserver.INSTANCE.endDrag();
  disposables.clear();
});

async function createView(initialNodes: readonly ExampleNode[] = [folder, child, loose], emptyActions: readonly (readonly ['folder' | 'item', string])[] = []) {
  let nodes = initialNodes;
  let revision = 1;
  const moveNodes = vi.fn(async () => ({ revision: ++revision }));
  const store: NavigatorStore<ExampleNode> = {
    getTree: async () => ({ nodes, revision }),
    moveNodes,
    createNode: async () => { throw new Error('Unexpected creation'); },
    updateNode: async () => { throw new Error('Unexpected update'); },
    deleteNode: async () => { throw new Error('Unexpected deletion'); },
  };
  const notifications = {} as INotificationService;
  const state = disposables.add(new NavigatorViewState<ExampleNode, NavigatorStore<ExampleNode>>('work', { store, onDidChangeTree: Event.None }, {
    tree: {
      types: {
        folder: { container: true, allowedParents: [null, 'folder'] },
        item: { container: false, allowedParents: [null, 'folder'] },
      },
      label: node => node.title,
      isId: (value): value is string => typeof value === 'string',
      maxNodes: 10,
      invalidTree: 'Invalid tree',
    },
    storageKey: 'example.navigator',
    isRevision: (value): value is number => typeof value === 'number',
    normalizeTitle: value => value.trim(),
    isConflict: () => false,
    messages: { loadFailed: 'Load failed', writeFailed: 'Write failed', conflictReloadFailed: 'Reload failed', conflictReloaded: 'Reloaded' },
  }, disposables.add(new InMemoryStorageService()), notifications, {} as IDialogService));

  const parent = document.body.appendChild(document.createElement('div'));
  disposables.add(toDisposable(() => parent.remove()));
  const instantiation = new InstantiationService(new ServiceCollection([INotificationService, notifications]));
  disposables.add(new NavigatorView(parent, state, {
    cssPrefix: 'characters',
    treeLabel: 'Example Navigator',
    rowIcon: node => node.kind === 'folder' ? { id: 'folder' } :
      node.status === 'read' ? { id: 'check', label: 'Read' } : { id: 'circle', label: 'Unread' },
    emptyHint: 'No notes',
    emptyActions,
    loadingMessage: 'Loading notes',
    invalidTitle: 'Invalid title',
    titleReloaded: 'Reloaded',
    menuId: MenuId.ManuscriptNavigatorContext,
    selectionKindKey: 'exampleKind',
    drag: { observer: CharactersDragAndDropObserver.INSTANCE, dropDatasetKey: 'charactersDrop' },
  }, {} as IContextKeyService, {} as IMenuService, {} as IContextMenuService, instantiation));
  const tree = parent.querySelector<HTMLElement>('[role="tree"]')!;
  Object.defineProperty(tree, 'clientHeight', { value: 240 });
  vi.spyOn(tree, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 240 } as DOMRect);
  await state.ensureLoaded();

  function markRead(): Promise<void> {
    revision++;
    nodes = [folder, child, { ...loose, status: 'read' }];
    return state.refresh();
  }
  return {
    state, moveNodes, markRead, parent,
    row: (key: string) => parent.querySelector<HTMLElement>(`[data-key="${key}"]`)!,
  };
}

function createTransfer() {
  const data = new Map<string, string>();
  return {
    data, get types() { return [...data.keys()]; }, effectAllowed: 'none', dropEffect: 'none',
    setData: (type: string, value: string) => data.set(type, value),
  };
}

function dragEvent(type: string, dataTransfer: ReturnType<typeof createTransfer>, clientY = 0): DragEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  return event as DragEvent;
}

test('updates the row icon and its description when only node status changes', async () => {
  const { row, markRead } = await createView();
  expect(row(loose.id).querySelector('.codicon-circle')).not.toBeNull();
  expect(row(loose.id).getAttribute('aria-description')).toBe('Unread');

  await markRead();

  expect(row(loose.id).getAttribute('aria-label')).toBe(loose.title);
  expect(row(loose.id).getAttribute('aria-description')).toBe('Read');
  expect(row(loose.id).querySelector('.codicon-check')).not.toBeNull();
  expect(row(loose.id).querySelector('.codicon-circle')).toBeNull();
});

test('marks the lower edge of an expanded folder and inserts before its first child', async () => {
  const { row, state, moveNodes } = await createView();
  state.toggle(folder.id);
  const data = createTransfer();
  row(loose.id).dispatchEvent(dragEvent('dragstart', data, 60));
  const enter = dragEvent('dragenter', data, 21);
  row(folder.id).dispatchEvent(enter);

  expect(enter.defaultPrevented).toBe(true);
  expect(data.dropEffect).toBe('move');
  expect(row(folder.id).dataset.charactersDrop).toBe('after');
  row(folder.id).dispatchEvent(dragEvent('drop', data, 21));
  await vi.waitFor(() => expect(moveNodes).toHaveBeenCalledExactlyOnceWith(
    'work', [loose.id], { parentId: folder.id, beforeId: child.id }, 1,
  ));
});

test('draws the hint and creation buttons when a view gives no empty-state renderer', async () => {
  const { parent } = await createView([], [['folder', 'New Folder'], ['item', 'New Note']]);
  const empty = parent.querySelector<HTMLElement>('.characters-empty')!;
  expect(empty.hidden).toBe(false);
  expect([...empty.children].map(element => `${element.tagName}:${element.textContent}`))
    .toEqual(['P:No notes', 'BUTTON:New Folder', 'BUTTON:New Note']);
});

test('keeps a World row drag away from tree views by its marker and while it lasts', () => {
  const world = WorldDragAndDropObserver.INSTANCE;
  const transfer = createTransfer();
  const event = dragEvent('dragstart', transfer);
  world.startDrag(event, document.createElement('div'), { workId: 'work', nodeIds: ['node'] });
  expect(isWorkbenchDrag(dragEvent('dragover', createTransfer()))).toBe(true);
  world.endDrag();
  expect(isWorkbenchDrag(event)).toBe(true);
  expect(isWorkbenchDrag(dragEvent('dragover', createTransfer()))).toBe(false);
});

test('isolates simultaneous drag payloads even for the same work and node ID', () => {
  const manuscript = ManuscriptDragAndDropObserver.INSTANCE;
  const characters = CharactersDragAndDropObserver.INSTANCE;
  const element = document.createElement('div');
  const ids = ['same-id'];
  const item = { workId: 'same-work', nodeIds: ids };
  const manuscriptTransfer = createTransfer();
  const charactersTransfer = createTransfer();
  const manuscriptEvent = dragEvent('dragstart', manuscriptTransfer);
  const charactersEvent = dragEvent('dragstart', charactersTransfer);
  manuscript.startDrag(manuscriptEvent, element, item);
  characters.startDrag(charactersEvent, element, item);

  expect([...manuscriptTransfer.data]).toEqual([['application/x-writing-room-manuscript', '1']]);
  expect([...charactersTransfer.data]).toEqual([['application/x-writing-room-characters', '1']]);
  expect(manuscript.getDraggedItems(manuscriptEvent, element)).toEqual(item);
  expect(characters.getDraggedItems(charactersEvent, element)).toEqual(item);
  expect(manuscript.getDraggedItems(charactersEvent, element)).toBeUndefined();
  expect(characters.getDraggedItems(manuscriptEvent, element)).toBeUndefined();

  manuscript.endDrag();
  expect(isWorkbenchDrag(dragEvent('dragover', createTransfer()))).toBe(true);
  characters.endDrag();
  expect(isWorkbenchDrag(charactersEvent)).toBe(true);
  expect(isWorkbenchDrag(dragEvent('dragover', createTransfer()))).toBe(false);
});
