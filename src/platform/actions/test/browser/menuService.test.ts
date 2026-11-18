import { expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../commands/common/commands.js';
import { ContextKeyService } from '../../../contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../contextkey/common/contextkey.js';
import { NullKeybindingService } from '../../../keybinding/common/keybinding.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../keybinding/common/keybindingsRegistry.js';
import { Action2, MenuId, MenuItemAction, MenuRegistry, registerAction2 } from '../../common/actions.js';
import { MenuService } from '../../common/menuService.js';

test('orders menus and tracks relevant keys, registry batches and disposal', async () => {
  const disposables = new DisposableStore();
  const context = disposables.add(new ContextKeyService());
  const service = new MenuService({ _serviceBrand: undefined, executeCommand: vi.fn() }, new NullKeybindingService());
  const id = MenuId.for('test.menu');
  const menu = disposables.add(service.createMenu(id, context));
  const changed = vi.fn();
  disposables.add(menu.onDidChange(changed));
  const show = context.createKey<boolean>('show', false);
  const enabled = context.createKey<boolean>('enabled', false);
  const checked = context.createKey<boolean>('checked', false);
  try {
    const last = disposables.add(MenuRegistry.appendMenuItem(id, { command: { id: 'last', title: 'Last' } }));
    for (const [group, order, title] of [
      ['z', 0, 'Z'], ['a', 2, 'B'], ['a', 2, 'A'], ['a', -1, 'First'], ['navigation', 0, 'Go'],
    ] as const) {
      disposables.add(MenuRegistry.appendMenuItem(id, { command: { id: title, title }, group, order }));
    }
    disposables.add(MenuRegistry.appendMenuItem(id, {
      command: { id: 'toggle', title: 'Toggle', precondition: ContextKeyExpr.has('enabled'), toggled: ContextKeyExpr.has('checked') },
      when: ContextKeyExpr.has('show'),
    }));

    expect(menu.getActions().map(([group, actions]) => [group, actions.map(action => action.label)]))
      .toEqual([['navigation', ['Go']], ['a', ['First', 'A', 'B']], ['z', ['Z']], ['', ['Last']]]);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
    context.createKey('unrelated', true);
    expect(changed).toHaveBeenCalledTimes(1);

    show.set(true);
    let toggle = menu.getActions().at(-1)![1].at(-1) as MenuItemAction;
    expect([toggle.label, toggle.enabled, toggle.checked]).toEqual(['Toggle', false, false]);
    enabled.set(true);
    checked.set(true);
    toggle = menu.getActions().at(-1)![1].at(-1) as MenuItemAction;
    expect([toggle.enabled, toggle.checked]).toEqual([true, true]);
    expect(changed).toHaveBeenCalledTimes(4);
    last.dispose();
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(5);
    expect(menu.getActions().at(-1)![1].map(action => action.id)).toEqual(['toggle']);
  } finally {
    disposables.dispose();
  }
});

test('Action2 disposes command, explicit and implicit menu entries, and sorted keybindings', () => {
  const lower = KeybindingsRegistry.registerKeybindingRule({ id: 'test.other', weight: KeybindingWeight.EditorCore, key: 'f2' });
  const registration = registerAction2(class extends Action2 {
    constructor() {
      super({
        id: 'test.action2', title: 'Test Action', f1: true,
        menu: { id: MenuId.MenubarHelpMenu },
        keybinding: { weight: KeybindingWeight.WorkbenchContrib, key: 'f1' },
      });
    }
    run() {}
  });
  try {
    expect(CommandsRegistry.getCommand('test.action2')).toBeDefined();
    expect(MenuRegistry.getMenuItems(MenuId.CommandPalette)).toContainEqual({ command: { id: 'test.action2', title: 'Test Action' } });
    expect(MenuRegistry.getMenuItems(MenuId.MenubarHelpMenu)).toHaveLength(1);
    expect(KeybindingsRegistry.getDefaultKeybindings().map(rule => rule.id)).toEqual(['test.other', 'test.action2']);
  } finally {
    registration.dispose();
    lower.dispose();
  }
  expect(CommandsRegistry.getCommand('test.action2')).toBeUndefined();
  expect(MenuRegistry.getMenuItems(MenuId.CommandPalette)).toEqual([]);
  expect(MenuRegistry.getMenuItems(MenuId.MenubarHelpMenu)).toEqual([]);
  expect(KeybindingsRegistry.getDefaultKeybindings()).toEqual([]);
});

test('uses an explicit palette entry in preference to implicit command metadata', () => {
  const command = { id: 'test.explicit', title: 'Explicit' };
  const declaration = MenuRegistry.addCommand(command);
  const item = { command, when: ContextKeyExpr.false() };
  const explicit = MenuRegistry.appendMenuItem(MenuId.CommandPalette, item);
  try {
    expect(MenuRegistry.getMenuItems(MenuId.CommandPalette)).toEqual([item]);
    explicit.dispose();
    expect(MenuRegistry.getMenuItems(MenuId.CommandPalette)).toEqual([{ command }]);
  } finally {
    explicit.dispose();
    declaration.dispose();
  }
});
