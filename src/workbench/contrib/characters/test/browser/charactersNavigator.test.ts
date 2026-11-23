import { afterEach, expect, test, vi } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { CharacterStoreError, type CharacterEntry, type CharacterNode } from '../../../../../platform/characters/common/characters.js';
import type { CharactersStore } from '../../../../../platform/characters/common/charactersStore.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import type { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { CharactersDragAndDropObserver } from '../../../../browser/dnd.js';
import type { ICharactersService } from '../../../../services/characters/common/charactersService.js';
import type { IWorkService } from '../../../../services/work/common/work.js';
import '../../browser/characters.contribution.js';
import { CharactersNavigator } from '../../browser/charactersNavigator.js';
import { CharactersViewState, ICharactersViewState } from '../../browser/charactersViewState.js';

const id = (number: number) => '00000000-0000-0000-0000-' + String(number).padStart(12, '0');
const workId = id(1);
const character: CharacterEntry = {
  id: id(2), kind: 'character', title: 'Rin', parentId: null, position: 0, type: 'unknown',
  values: {}, createdAt: 0, updatedAt: 0,
};
const disposables = new DisposableStore();
afterEach(() => disposables.clear());

function createNavigator(
  work = { current: { id: workId } } as IWorkService,
  nodes: CharacterNode[] = [character],
) {
  const changes = disposables.add(new Emitter<string>());
  let snapshot = { nodes, revision: 1 };
  const getTree = vi.fn(async () => snapshot);
  const updateNode = vi.fn<CharactersStore['updateNode']>(async (_workId, nodeId, update, expected) => {
    const previous = snapshot.nodes.find(node => node.id === nodeId);
    if (previous?.kind !== 'character' || expected !== snapshot.revision) {
      throw new Error('Unexpected write');
    }
    const node = { ...previous, ...update };
    snapshot = { nodes: snapshot.nodes.map(current => current.id === nodeId ? node : current), revision: snapshot.revision + 1 };
    changes.fire(workId);
    return { node, revision: snapshot.revision };
  });
  const notifications = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const dialogs = { prompt: vi.fn(() => ({ result: Promise.resolve(0) })) };
  const deleteNode = vi.fn<CharactersStore['deleteNode']>();
  const characters = { store: { getTree, updateNode, deleteNode }, onDidChangeTree: changes.event } as unknown as ICharactersService;
  const state = disposables.add(new CharactersViewState(work, characters, disposables.add(new InMemoryStorageService()),
    notifications as unknown as INotificationService, dialogs as unknown as IDialogService));
  const parent = document.body.appendChild(document.createElement('div'));
  disposables.add(toDisposable(() => parent.remove()));
  const instantiation = new InstantiationService(new ServiceCollection(
    [INotificationService, notifications], [ICharactersViewState, state],
  ));
  disposables.add(new CharactersNavigator(parent, state, {} as IContextKeyService, {} as IMenuService,
    {} as IContextMenuService, instantiation));
  return {
    state, getTree, updateNode, deleteNode, changes, notifications, dialogs, instantiation,
    tree: parent.querySelector<HTMLElement>('[role="tree"]')!,
    row: () => parent.querySelector<HTMLElement>('[role="treeitem"]')!,
  };
}

test('keeps focus and folder when activating a character by double click or Enter', async () => {
  const { state, row, tree } = createNavigator();
  await state.ensureLoaded();
  row().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(state.folderId).toBeNull();
  expect(tree.getAttribute('aria-activedescendant')).toBe(row().id);
});

test('reloads matching tree changes and reads once after a local write', async () => {
  const { state, getTree, updateNode, changes, row } = createNavigator();
  await state.ensureLoaded();
  changes.fire(id(99));
  expect(getTree).toHaveBeenCalledTimes(1);
  changes.fire(workId);
  await state.refresh();
  expect(getTree).toHaveBeenCalledTimes(2);

  await state.rename(character.id, 'New name', 1);
  expect(updateNode).toHaveBeenCalledExactlyOnceWith(workId, character.id, { title: 'New name' }, 1);
  expect(getTree).toHaveBeenCalledTimes(3);
  expect(row().getAttribute('aria-label')).toBe('New name');
});

test('does not read the store without a work', async () => {
  const { state, getTree } = createNavigator({} as IWorkService);
  await state.ensureLoaded();
  expect(getTree).not.toHaveBeenCalled();
});

test('blocks drags during inline editing and clears a drag released outside the navigator', async () => {
  const { state, row } = createNavigator();
  await state.ensureLoaded();
  const observer = CharactersDragAndDropObserver.INSTANCE;

  const startDrag = () => {
    const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: [], effectAllowed: 'none', setData() {} },
    });
    row().dispatchEvent(event);
    return event;
  };

  state.startRename(character.id);
  expect(startDrag().defaultPrevented).toBe(true);
  expect(observer.isDragging).toBe(false);
  state.cancelRename(state.editing!);

  const iframe = document.body.appendChild(document.createElement('iframe'));
  disposables.add(toDisposable(() => iframe.remove()));
  expect(startDrag().defaultPrevented).toBe(false);
  expect(observer.isDragging).toBe(true);
  iframe.dispatchEvent(new Event('drop', { bubbles: true }));
  await vi.waitFor(() => expect(observer.isDragging).toBe(false));
});

const second: CharacterEntry = { ...character, id: id(3), title: 'Pip', type: 'male', position: 1 };
const folder: CharacterNode = {
  kind: 'folder', id: id(4), title: 'Cast', parentId: null, position: 2, createdAt: 0, updatedAt: 0,
};
const outside: CharacterEntry = { ...character, id: id(5), title: 'Outside', position: 3 };

test('Set Type uses all selected characters and ignores a folder and a command argument', async () => {
  const { state, getTree, updateNode, instantiation } = createNavigator(undefined, [character, second, folder, outside]);
  await state.ensureLoaded();
  state.select(character.id);
  state.select(folder.id, true);
  state.select(second.id, true);

  const action = CommandsRegistry.getCommand('characters.setTypeAnimal')!;
  await instantiation.invokeFunction(accessor => action.handler(accessor, outside.id));
  expect(updateNode.mock.calls).toEqual([
    [workId, character.id, { type: 'animal' }, 1],
    [workId, second.id, { type: 'animal' }, 2],
  ]);
  expect(getTree).toHaveBeenCalledTimes(2);
  expect(state.index?.nodes.get(outside.id)?.type).toBe('unknown');

  state.select(folder.id);
  await instantiation.invokeFunction(accessor => action.handler(accessor, character.id));
  expect(updateNode).toHaveBeenCalledTimes(2);
});

test.each([
  { error: new CharacterStoreError('conflict', 3), notification: 'warn' },
  { error: new CharacterStoreError('invalid'), notification: 'error' },
] as const)('reloads a partial type change after a $notification and attempts no later writes', async ({ error, notification }) => {
  const { state, getTree, updateNode, notifications } = createNavigator(undefined, [character, second, folder, outside]);
  updateNode.mockImplementationOnce(updateNode.getMockImplementation()!).mockRejectedValueOnce(error);
  await state.ensureLoaded();
  state.select(character.id);
  state.select(second.id, true);
  state.select(outside.id, true);
  await state.setType('female');

  expect(updateNode.mock.calls).toEqual([
    [workId, character.id, { type: 'female' }, 1],
    [workId, second.id, { type: 'female' }, 2],
  ]);
  expect(getTree).toHaveBeenCalledTimes(2);
  expect(state.index?.nodes.get(character.id)?.type).toBe('female');
  expect(state.index?.nodes.get(second.id)?.type).toBe('male');
  expect(notifications[notification]).toHaveBeenCalledOnce();
});

test('counts only characters at every depth in a folder deletion prompt', async () => {
  const root = { ...folder, position: 0 };
  const inner = { ...folder, id: id(7), parentId: root.id, position: 0 };
  const child = { ...character, parentId: inner.id };
  const { state, dialogs, deleteNode } = createNavigator(undefined, [root, inner, child]);
  await state.ensureLoaded();
  state.select(root.id);
  await state.deleteSelected();
  expect(dialogs.prompt).toHaveBeenCalledWith(expect.objectContaining({ message: 'Delete "Cast" and 1 character in it?' }));
  expect(deleteNode).not.toHaveBeenCalled();
});
