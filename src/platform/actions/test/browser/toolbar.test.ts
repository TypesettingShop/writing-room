import { expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ContextKeyService } from '../../../contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../contextkey/common/contextkey.js';
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

test('updates a choice from context and runs the command with the selected menu arguments', async () => {
  const disposables = new DisposableStore();
  const toolbarMenu = MenuId.for('test.toolbar.select');
  const submenu = MenuId.for('test.toolbar.select.options');
  const container = document.createElement('div');
  const executeCommand = vi.fn().mockResolvedValue(undefined);
  document.body.append(container);
  try {
    const context = disposables.add(new ContextKeyService());
    const style = context.createKey<string>('test.style', 'body');
    const menus = new MenuService({ _serviceBrand: undefined, executeCommand }, new NullKeybindingService());
    disposables.add(MenuRegistry.appendMenuItem(toolbarMenu, { submenu, title: 'Style', select: true, group: '2_style' }));
    disposables.add(MenuRegistry.appendMenuItem(toolbarMenu, {
      command: { id: 'another', title: 'Another action' }, group: '3_inline',
    }));
    for (const [order, title] of ['body', 'heading'].entries()) {
      disposables.add(MenuRegistry.appendMenuItem(submenu, {
        command: { id: 'test.setStyle', title, toggled: ContextKeyExpr.equals('test.style', title) },
        args: [{ type: title }], order,
      }));
    }
    disposables.add(new MenuWorkbenchToolBar(
      { element: container, ariaLabel: 'Formatting' }, toolbarMenu, context, menus, new BrowserLayoutService(),
    ));
    const choices = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]:not([hidden])')!;
    expect(choices().getAttribute('aria-label')).toBe('Style');
    expect(choices().getAttribute('aria-description')).toBe('body');
    choices().focus();
    choices().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Another action');
    style.set('heading');
    await Promise.resolve();
    expect(choices().getAttribute('aria-label')).toBe('Style');
    expect(choices().textContent).toBe('heading');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Another action');
    choices().click();
    expect(document.querySelector('[role="menuitemradio"][aria-label="heading"]')?.getAttribute('aria-checked')).toBe('true');
    document.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-label="body"]')!.click();
    expect(executeCommand).toHaveBeenCalledWith('test.setStyle', { type: 'body' });
  } finally {
    disposables.dispose();
    container.remove();
  }
});
