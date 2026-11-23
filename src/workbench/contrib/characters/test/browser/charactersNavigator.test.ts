import { afterEach, expect, test, vi } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IMenuService } from '../../../../../platform/actions/common/actions.js';
import type { CharacterEntry } from '../../../../../platform/characters/common/characters.js';
import type { CharactersStore } from '../../../../../platform/characters/common/charactersStore.js';
import type { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import type { ICharactersService } from '../../../../services/characters/common/charactersService.js';
import type { IWorkService } from '../../../../services/work/common/work.js';
import { CharactersNavigator } from '../../browser/charactersNavigator.js';
import { CharactersViewState } from '../../browser/charactersViewState.js';

const id = (number: number) => '00000000-0000-0000-0000-' + String(number).padStart(12, '0');
const workId = id(1);
const character: CharacterEntry = {
  id: id(2), kind: 'character', title: 'Rin', parentId: null, position: 0, type: 'unknown',
  values: {}, createdAt: 0, updatedAt: 0,
};
const disposables = new DisposableStore();
afterEach(() => disposables.clear());

function createNavigator(work = { current: { id: workId } } as IWorkService) {
  const changes = disposables.add(new Emitter<string>());
  let snapshot = { nodes: [character], revision: 1 };
  const getTree = vi.fn(async () => snapshot);
  const updateNode = vi.fn<CharactersStore['updateNode']>(async (_workId, _nodeId, update) => {
    const node = { ...character, ...update };
    snapshot = { nodes: [node], revision: snapshot.revision + 1 };
    changes.fire(workId);
    return { node, revision: snapshot.revision };
  });
  const notifications = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const dialogs = { prompt: vi.fn(() => ({ result: Promise.resolve(0) })) };
  const characters = { store: { getTree, updateNode }, onDidChangeTree: changes.event } as unknown as ICharactersService;
  const state = disposables.add(new CharactersViewState(work, characters, disposables.add(new InMemoryStorageService()),
    notifications as unknown as INotificationService, dialogs as unknown as IDialogService));
  const parent = document.body.appendChild(document.createElement('div'));
  disposables.add(toDisposable(() => parent.remove()));
  const instantiation = new InstantiationService(new ServiceCollection([INotificationService, notifications]));
  disposables.add(new CharactersNavigator(parent, state, {} as IContextKeyService, {} as IMenuService,
    {} as IContextMenuService, instantiation));
  return {
    state, getTree, updateNode, changes, notifications, dialogs,
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
