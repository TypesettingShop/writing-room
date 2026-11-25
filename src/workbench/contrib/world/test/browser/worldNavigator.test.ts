import { afterEach, expect, test, vi } from 'vitest';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, type ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { WorldStoreError, type WorldTree } from '../../../../../platform/world/common/world.js';
import type { WorldStore } from '../../../../../platform/world/common/worldStore.js';
import type { IWorkService } from '../../../../services/work/common/work.js';
import type { IWorldService } from '../../../../services/world/common/worldService.js';
import { WorldNavigator } from '../../browser/worldNavigator.js';
import { WorldViewState } from '../../browser/worldViewState.js';

const workId = '00000000-0000-0000-0000-000000000001';
const calendar = {
  kind: 'calendar', id: '00000000-0000-0000-0000-000000000002', parentId: null,
  position: 0, title: '달력', createdAt: 0, updatedAt: 0,
} as const;
const disposables = new DisposableStore();
afterEach(() => disposables.clear());

function setup(snapshot: WorldTree = { nodes: [], revision: 0 }) {
  const getTree = vi.fn(async () => snapshot);
  const applyPreset = vi.fn<WorldStore['applyPreset']>(async () => snapshot);
  const notifications = { warn: vi.fn(), error: vi.fn() };
  const state = disposables.add(new WorldViewState(
    { current: { id: workId } } as IWorkService,
    { store: { getTree, applyPreset }, onDidChangeTree: Event.None } as unknown as IWorldService,
    disposables.add(new InMemoryStorageService()), notifications as unknown as INotificationService, {} as IDialogService,
  ));
  const parent = document.body.appendChild(document.createElement('div'));
  disposables.add(toDisposable(() => parent.remove()));
  const commands = { executeCommand: vi.fn(async () => {}) };
  disposables.add(new WorldNavigator(parent, state, {} as IContextKeyService, {} as IMenuService,
    {} as IContextMenuService, new InstantiationService(new ServiceCollection([INotificationService, notifications])), commands as unknown as ICommandService,
    notifications as unknown as INotificationService));
  return {
    state, parent, getTree, applyPreset, notifications, commands,
    tree: parent.querySelector<HTMLElement>('[role="tree"]')!,
  };
}

test('the empty picker keeps focus and makes only one revisioned request while busy', async () => {
  const { parent, tree, state, getTree, applyPreset } = setup();
  await state.ensureLoaded();
  const buttons = parent.querySelectorAll<HTMLButtonElement>('.world-presets button');
  expect(buttons).toHaveLength(7);
  const fantasy = buttons[2];
  const pending = new DeferredPromise<WorldTree>();
  applyPreset.mockReturnValueOnce(pending.p);
  fantasy.focus();
  fantasy.click();
  fantasy.click();
  expect(applyPreset).toHaveBeenCalledExactlyOnceWith(workId, 'fantasy', 0);
  expect(fantasy.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(fantasy);

  const saved = { nodes: [calendar], revision: 1 };
  getTree.mockResolvedValue(saved);
  await pending.complete(saved);
  await vi.waitFor(() => expect(state.busy).toBe(false));
  expect(parent.querySelector<HTMLElement>('.world-empty')!.hidden).toBe(true);
  expect(document.activeElement).toBe(tree);
  expect(state.revision).toBe(1);
  await state.applyPreset('modern');
  expect(applyPreset).toHaveBeenCalledOnce();
});

test('a preset conflict refreshes the winning tree without another write', async () => {
  const { state, getTree, applyPreset, notifications } = setup();
  await state.ensureLoaded();
  applyPreset.mockRejectedValueOnce(new WorldStoreError('conflict', 1));
  getTree.mockResolvedValue({ nodes: [calendar], revision: 1 });
  await state.applyPreset('fantasy');
  expect(state.index?.nodes.get(calendar.id)).toEqual(calendar);
  expect(applyPreset).toHaveBeenCalledOnce();
  expect(notifications.warn).toHaveBeenCalledExactlyOnceWith('The world changed elsewhere. It has been reloaded.');
});

test('Enter routes a calendar row through the registered command without passing a node', async () => {
  disposables.add(CommandsRegistry.registerCommand('world.editCalendar', () => {}));
  const { state, tree, commands } = setup({ nodes: [calendar], revision: 1 });
  await state.ensureLoaded();
  tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(commands.executeCommand).toHaveBeenCalledExactlyOnceWith('world.editCalendar');
});
