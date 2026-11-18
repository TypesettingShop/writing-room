import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { NullKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { BrowserLayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import type { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { CommandsQuickAccessProvider } from '../../browser/commandsQuickAccess.js';

const historyKey = 'commandPalette.mru.cache';
let disposables: DisposableStore;
let context: ContextKeyService;
let storage: InMemoryStorageService;
let editor: HTMLTextAreaElement;
let provider: CommandsQuickAccessProvider;
const commandRun = vi.fn<(id: string, ...args: unknown[]) => Promise<unknown>>();
let picks: readonly (IQuickPickItem | IQuickPickSeparator)[];
let pickId: string | undefined;

beforeEach(() => {
  disposables = new DisposableStore();
  context = disposables.add(new ContextKeyService());
  storage = disposables.add(new InMemoryStorageService());
  editor = document.createElement('textarea');
  document.body.append(editor);
  commandRun.mockReset();
  const menus = new MenuService(
    {
      _serviceBrand: undefined,
      async executeCommand<T>(id: string, ...args: unknown[]): Promise<T> {
        return await commandRun(id, ...args) as T;
      },
    },
    new NullKeybindingService(),
  );
  const quickInput: IQuickInputService = {
    _serviceBrand: undefined,
    async pick<T extends IQuickPickItem>(items: readonly (T | IQuickPickSeparator)[]): Promise<T | undefined> {
      picks = items;
      return items.find((item): item is T => item.type !== 'separator' && item.id === pickId);
    },
    async input() { return undefined; },
  };
  provider = new CommandsQuickAccessProvider(menus, context, new BrowserLayoutService(), quickInput, storage);
  pickId = undefined;
});

afterEach(() => {
  disposables.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test('lists sorted, categorized, enabled commands in the focus scope', async () => {
  const scope = disposables.add(context.createScoped(editor));
  scope.createKey('editorTextFocus', true);
  const editorOnly = ContextKeyExpr.has('editorTextFocus');
  disposables.add(MenuRegistry.addCommand({ id: 'workspace', title: 'Open', category: 'Workspace' }));
  disposables.add(MenuRegistry.addCommand({ id: 'hidden', title: 'Hidden' }));
  disposables.add(MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
    command: { id: 'hidden', title: 'Hidden' },
    when: ContextKeyExpr.false(),
  }));
  disposables.add(MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
    command: { id: 'editor', title: { value: 'Duplicate', original: 'Duplicate' }, category: 'Editor' },
    when: editorOnly,
  }));
  disposables.add(MenuRegistry.addCommand({ id: 'disabled', title: 'Disabled', precondition: ContextKeyExpr.false() }));
  disposables.add(MenuRegistry.addCommand({ id: 'alpha', title: 'Alpha' }));

  await provider.show();
  expect(picks.map(item => item.label)).toEqual(['Alpha', 'Workspace: Open']);

  editor.focus();
  pickId = 'editor';
  await provider.show();
  expect(picks.map(item => item.label)).toEqual(['Alpha', 'Editor: Duplicate', 'Workspace: Open']);
  expect(commandRun).toHaveBeenCalledExactlyOnceWith('editor');
});

test('moves selections to the front, keeps fifty unique known ids, and separates other commands', async () => {
  const ids = Array.from({ length: 51 }, (_, index) => 'command-' + index);
  for (const id of ids) {
    disposables.add(MenuRegistry.addCommand({ id, title: id }));
  }
  storage.store(historyKey, [false, 'missing', ids[0], ids[0], ...ids.slice(1, 50)], StorageScope.PROFILE, StorageTarget.USER);
  pickId = ids[50];
  await provider.show();
  expect(picks.map(item => item.label)).toEqual(['Recently Used', ...ids.slice(0, 50), 'Other Commands', ids[50]]);

  pickId = undefined;
  await provider.show();
  expect(picks.map(item => item.label)).toEqual(['Recently Used', ids[50], ...ids.slice(0, 49), 'Other Commands', ids[49]]);
  expect(storage.getObject(historyKey, StorageScope.PROFILE)).toEqual([ids[50], ...ids.slice(0, 49)]);
});

test('ignores damaged history and logs command failures', async () => {
  disposables.add(MenuRegistry.addCommand({ id: 'broken', title: 'Broken command' }));
  for (const value of ['not JSON', '{"entries":[]}', 'null']) {
    storage.store(historyKey, value, StorageScope.PROFILE, StorageTarget.USER);
    await provider.show();
    expect(picks.map(item => item.label)).toEqual(['Broken command']);
  }

  const error = new Error('command failed');
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
  commandRun.mockRejectedValue(error);
  pickId = 'broken';
  await provider.show();
  expect(logger).toHaveBeenCalledExactlyOnceWith('Could not run command broken', error);
});
