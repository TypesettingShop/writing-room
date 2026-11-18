import { expect, test, vi } from 'vitest';
import { NotificationsToasts } from '../../../browser/parts/notifications/notificationsToasts.js';
import { MainThreadMessageService } from '../../browser/mainThreadMessageService.js';
import { MainThreadStatusBar } from '../../browser/mainThreadStatusBar.js';
import { ExtensionTreeViews, MainThreadTreeViews } from '../../browser/mainThreadTreeViews.js';
import { StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

test('message selections and dismissal settle independent requests', async () => {
  const layout = document.createElement('main');
  const toasts = new NotificationsToasts(layout);
  const messages = new MainThreadMessageService(toasts, () => true);
  const first = messages.$showMessage('a', 'warning', 'Choose', ['First', 'Second']);
  const second = messages.$showMessage('b', 'info', 'Dismiss', ['OK']);
  const elements = layout.querySelectorAll<HTMLElement>('.extension-toast');
  expect(elements).toHaveLength(2);
  elements[0].querySelectorAll<HTMLButtonElement>('.extension-toast-actions button')[1].click();
  expect(await first).toBe(1);
  messages.remove('b');
  expect(await second).toBeUndefined();
  expect(layout.querySelector('.extension-toast')).toBeNull();
  messages.dispose();
  toasts.dispose();
});

test('main thread removes every tree and status entry for an extension', async () => {
  const views = new ExtensionTreeViews();
  const trees = new MainThreadTreeViews({
    async $getChildren() { return []; },
    async $getTreeItem() { return undefined; },
  }, views, (_key, id) => id === 'tree');
  await expect(trees.$registerTreeViewDataProvider('a', 'unknown')).rejects.toThrow('No view is registered with id: unknown');
  await trees.$registerTreeViewDataProvider('a', 'tree');
  const refresh = vi.fn();
  views.get('tree')?.onDidRefresh(refresh);
  await trees.$refresh('a', 'tree', ['handle']);
  expect(refresh).toHaveBeenCalledExactlyOnceWith(['handle']);
  trees.remove('a');
  expect(views.get('tree')).toBeUndefined();

  const dispose = vi.fn();
  const update = vi.fn();
  const addEntry = vi.fn(() => ({ dispose, update }));
  const statusbar = new MainThreadStatusBar({ _serviceBrand: undefined, addEntry }, key => key === 'a' ? 'test.a' : undefined);
  await statusbar.$setEntry('a', '1', { alignment: 2, text: 'First' });
  await statusbar.$setEntry('a', '1', { alignment: 2, text: 'Second' });
  expect(addEntry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'First' }), 'test.a.1', StatusbarAlignment.RIGHT, 0);
  expect(update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'Second' }));
  statusbar.remove('a');
  expect(dispose).toHaveBeenCalledOnce();
  trees.dispose();
  views.dispose();
});
