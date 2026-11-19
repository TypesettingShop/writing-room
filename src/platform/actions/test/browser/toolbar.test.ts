import { expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ContextKeyService } from '../../../contextkey/browser/contextKeyService.js';
import { NullKeybindingService } from '../../../keybinding/common/keybinding.js';
import { BrowserLayoutService } from '../../../layout/browser/layoutService.js';
import { MenuWorkbenchToolBar } from '../../browser/toolbar.js';
import { MenuId, MenuRegistry } from '../../common/actions.js';
import { MenuService } from '../../common/menuService.js';

test('overflow and submenu buttons cancel only primary-button presses', () => {
  const disposables = new DisposableStore();
  const toolbarMenu = MenuId.for('test.toolbar');
  const submenu = MenuId.for('test.toolbar.submenu');
  const action = { command: { id: 'test.toolbar.command', title: 'Toolbar command' } };
  const container = document.createElement('div');
  try {
    disposables.add(MenuRegistry.appendMenuItem(toolbarMenu, action));
    disposables.add(MenuRegistry.appendMenuItem(submenu, action));
    disposables.add(MenuRegistry.appendMenuItem(toolbarMenu, { submenu, title: 'Test Submenu', group: 'navigation' }));
    const context = disposables.add(new ContextKeyService());
    const menus = new MenuService({ _serviceBrand: undefined, executeCommand: vi.fn() }, new NullKeybindingService());
    disposables.add(new MenuWorkbenchToolBar(container, toolbarMenu, context, menus, new BrowserLayoutService()));

    const buttons = ['More Actions', 'Test Submenu'].map(label =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!);
    expect(buttons.map(button => button?.hidden)).toEqual([false, false]);
    const defaultAllowed = buttons.map(button => [0, 1, 2].map(pressed =>
      button.dispatchEvent(new MouseEvent('mousedown', { button: pressed, bubbles: true, cancelable: true }))));
    expect(defaultAllowed).toEqual([[false, true, true], [false, true, true]]);
  } finally {
    disposables.dispose();
  }
});
