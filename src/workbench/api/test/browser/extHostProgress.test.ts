import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { BrowserLayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { DialogService } from '../../../../platform/dialogs/browser/dialogService.js';
import { NotificationService, toastAutoCloseDelay } from '../../../browser/parts/notifications/notificationsToasts.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import type { IStatusbarEntry, IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import { MainThreadMessageService } from '../../browser/mainThreadMessageService.js';
import { MainThreadProgress } from '../../browser/mainThreadProgress.js';
import { MainThreadMessageServiceProxy } from '../../common/extHost.protocol.messages.js';
import { ExtHostProgressProxy, MainThreadProgressProxy } from '../../common/extHost.protocol.windowUi.js';
import type { MainThreadMessageOptionsShape } from '../../common/extHost.protocol.windowUi.js';
import { ExtHostMessageService } from '../../common/extHostMessageService.js';
import { ExtHostProgress, ProgressLocation } from '../../common/extHostProgress.js';
import { createDomRpcPair, settle } from './windowUiTestRpc.js';

let pair: ReturnType<typeof createDomRpcPair>;
let notifications: NotificationService;
let messages: MainThreadMessageService;
let mainProgress: MainThreadProgress;
let progress: ExtHostProgress;
let hostMessages: ExtHostMessageService;
let entries: Map<string, { entry: IStatusbarEntry; disposed: boolean; updates: number }>;
let previous: HTMLTextAreaElement;

const extensions = new Map<string, HostExtensionDescription>([['a', {
  id: 'test.a', key: 'a', location: 'https://example.test/a/', entry: 'https://example.test/a/extension.js',
  activationEvents: [], manifest: { name: 'a', publisher: 'test', version: '1.0.0', displayName: 'Fixture A' },
}]]);

beforeEach(() => {
  const layout = new BrowserLayoutService();
  notifications = new NotificationService(layout);
  entries = new Map();
  const statusbar: IStatusbarService = {
    _serviceBrand: undefined,
    addEntry(entry, id) {
      const record = { entry, disposed: false, updates: 0 };
      entries.set(id, record);
      return { update: next => { record.entry = next; record.updates++; }, dispose: () => { record.disposed = true; } };
    },
  };
  pair = createDomRpcPair();
  messages = new MainThreadMessageService(notifications, new DialogService(layout), key => extensions.get(key));
  pair.main.set(MainThreadMessageServiceProxy, messages);
  mainProgress = new MainThreadProgress(pair.main.getProxy(ExtHostProgressProxy), notifications, statusbar, key => extensions.get(key));
  pair.main.set(MainThreadProgressProxy, mainProgress);
  progress = new ExtHostProgress(pair.worker.getProxy(MainThreadProgressProxy));
  pair.worker.set(ExtHostProgressProxy, progress);
  hostMessages = new ExtHostMessageService(pair.worker.getProxy(MainThreadMessageServiceProxy) as unknown as MainThreadMessageOptionsShape);
  previous = document.createElement('textarea');
  document.body.append(previous);
  previous.focus();
});

afterEach(() => {
  vi.useRealTimers();
  progress.dispose();
  mainProgress.dispose();
  messages.dispose();
  notifications.dispose();
  pair.dispose();
  document.body.replaceChildren();
});

const toasts = () => [...document.querySelectorAll<HTMLElement>('.extension-toast')];
const dialog = () => document.querySelector<HTMLElement>('[role=dialog]');
const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === name)!;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('a toast answers with the item object, shows its source and reads the message as text', async () => {
  const items = [{ title: 'First' }, { title: 'Second' }];
  const answer = hostMessages.showMessage('a', 'warning', '<img src=x onerror=alert(1)>', ...items);
  await settle();
  const [toast] = toasts();
  expect(toast.querySelector('img')).toBeNull();
  expect(toast.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(toast.querySelector('.extension-toast-source')?.textContent).toBe('Source: Fixture A');
  button(toast, 'Second').click();
  expect(await answer).toBe(items[1]);

  const dismissed = hostMessages.showMessage('a', 'info', 'Dismiss me', 'OK');
  await settle();
  toasts()[0].querySelector<HTMLButtonElement>('[aria-label="Dismiss message"]')!.click();
  expect(await dismissed).toBeUndefined();
});

test('automatic close resolves the extension response and calls prompt cancellation once', async () => {
  vi.useFakeTimers();
  const answer = hostMessages.showMessage('a', 'info', 'Plain information');
  const onCancel = vi.fn();
  const prompt = notifications.prompt(Severity.Info, 'No choices', [], { onCancel });
  await vi.advanceTimersByTimeAsync(30);
  expect(toasts().map(toast => toast.getAttribute('aria-label'))).toEqual(['No choices', 'Plain information']);
  await vi.advanceTimersByTimeAsync(toastAutoCloseDelay);
  expect(await answer).toBeUndefined();
  expect(toasts()).toEqual([]);
  prompt.close();
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('removing an extension settles its visible, displaced and never displayed toasts', async () => {
  vi.useFakeTimers();
  const answers = ['One', 'Two', 'Three', 'Four'].map(text => hostMessages.showMessage('a', 'info', text));
  await vi.advanceTimersByTimeAsync(30);
  expect(toasts().map(toast => toast.getAttribute('aria-label'))).toEqual(['One', 'Two', 'Three']);
  notifications.error('Urgent');
  expect(toasts().map(toast => toast.getAttribute('aria-label'))).toEqual(['One', 'Two', 'Urgent']);
  messages.remove('a');
  await vi.advanceTimersByTimeAsync(30);
  expect(await Promise.all(answers)).toEqual([undefined, undefined, undefined, undefined]);
  expect(toasts().map(toast => toast.getAttribute('aria-label'))).toEqual(['Urgent']);
  expect(vi.getTimerCount()).toBe(0);
});

test('a modal message is a dialog whose Escape answers with the close item, or undefined', async () => {
  const keep = { title: 'Keep', isCloseAffordance: true };
  const remove = { title: 'Delete' };
  const answer = hostMessages.showMessage('a', 'warning', 'Delete the note?', { modal: true, detail: 'It goes for good.' }, keep, remove);
  await settle();
  expect(dialog()?.getAttribute('aria-modal')).toBe('true');
  expect(dialog()?.textContent).toContain('It goes for good.');
  expect([...dialog()!.querySelectorAll('button')].map(element => element.textContent)).toEqual(['Delete', 'Keep']);
  dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(await answer).toBe(keep);
  expect(document.activeElement).toBe(previous);

  const chosen = hostMessages.showMessage('a', 'info', 'Pick', { modal: true }, remove);
  await settle();
  button(dialog()!, 'Delete').click();
  expect(await chosen).toBe(remove);

  const cancelled = hostMessages.showMessage('a', 'info', 'Pick', { modal: true }, 'Yes');
  await settle();
  expect([...dialog()!.querySelectorAll('button')].map(element => element.textContent)).toEqual(['Yes', 'Cancel']);
  dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(await cancelled).toBeUndefined();

  // Detail shows only in a modal message, as in VS Code.
  // Left open: the host stops under it at the end of the test.
  hostMessages.showMessage('a', 'info', 'Plain', { detail: 'Hidden detail' }).catch(() => {});
  await settle();
  expect(toasts().at(-1)?.textContent).not.toContain('Hidden detail');
});

test('three toasts show at once, the rest wait, and a flood drops its oldest waiting toasts', async () => {
  const answers = Array.from({ length: 15 }, (_, index) => hostMessages.showMessage('a', 'info', 'Message ' + index, 'OK'));
  answers.forEach(answer => answer.catch(() => {}));
  await settle();
  expect(toasts().map(toast => toast.getAttribute('aria-label'))).toEqual(['Message 0', 'Message 1', 'Message 2']);
  // Twelve waited; the two oldest of them were dropped to keep ten.
  expect(await answers[3]).toBeUndefined();
  expect(await answers[4]).toBeUndefined();
  button(toasts()[0], 'OK').click();
  expect(await answers[0]).toBe('OK');
  expect(toasts().map(toast => toast.getAttribute('aria-label'))).toEqual(['Message 1', 'Message 2', 'Message 5']);
});

test('removing an extension closes its toasts, dialogs and progress', async () => {
  const toast = hostMessages.showMessage('a', 'info', 'Toast', 'OK');
  const modal = hostMessages.showMessage('a', 'info', 'Modal', { modal: true }, 'OK');
  void progress.withProgress('a', { location: ProgressLocation.Notification, title: 'Working' }, () => new Promise(() => {}));
  void progress.withProgress('a', { location: ProgressLocation.Window, title: 'Indexing' }, () => new Promise(() => {}));
  await settle();
  expect(dialog()).not.toBeNull();
  messages.remove('a');
  mainProgress.remove('a');
  expect(await toast).toBeUndefined();
  expect(await modal).toBeUndefined();
  expect(toasts()).toEqual([]);
  expect(dialog()).toBeNull();
  expect([...entries.values()].every(record => record.disposed)).toBe(true);
});

test('releasing an extension cancels the tokens of its running tasks, cancellable or not, and only its own', async () => {
  const tokens: vscode.CancellationToken[] = [];
  const task = (_: unknown, token: vscode.CancellationToken) => {
    tokens.push(token);
    return new Promise<void>(() => {});
  };
  void progress.withProgress('a', { location: ProgressLocation.Notification, title: 'Cancellable', cancellable: true }, task);
  void progress.withProgress('a', { location: ProgressLocation.Window, title: 'Not cancellable' }, task);
  void progress.withProgress('b', { location: ProgressLocation.Window, title: 'Another extension' }, task);
  await settle();
  progress.release('a');
  expect(tokens.map(token => token.isCancellationRequested)).toEqual([true, true, false]);
});

test('waiting toasts stop at fifty in all, the oldest going first', async () => {
  const closed: number[] = [];
  for (let index = 0; index < 3 + 60; index++) {
    notifications.notify({ severity: Severity.Info, message: 'Toast ' + index, source: 'source ' + (index % 7) })
      .onDidClose(() => closed.push(index));
  }
  // Nine per source wait, under the limit per source; sixty in all are ten more than may wait.
  expect(closed).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('notification progress shows a bar that stops at 100, cancels once and stays until the task ends', async () => {
  const task = deferred<string>();
  let token!: vscode.CancellationToken;
  let report!: vscode.Progress<{ message?: string; increment?: number }>['report'];
  const cancelled = vi.fn();
  const result = progress.withProgress('a', { location: ProgressLocation.Notification, title: 'Exporting', cancellable: true },
    (progressReporter, cancellation) => {
      report = value => progressReporter.report(value);
      token = cancellation;
      token.onCancellationRequested(cancelled);
      return task.promise;
    });
  await settle();
  const [toast] = toasts();
  expect(toast.querySelector('.extension-toast-source')?.textContent).toBe('Source: Fixture A');
  report({ message: 'half', increment: 70 });
  await settle();
  report({ increment: 70 });
  await new Promise(resolve => setTimeout(resolve, 150));
  await settle();
  const bar = toast.querySelector('[role=progressbar]')!;
  expect(bar.getAttribute('aria-valuenow')).toBe('100');
  expect(toast.querySelector('[role=status]')?.textContent).toBe('Exporting: half');

  button(toast, 'Cancel').click();
  button(toast, 'Cancel').click();
  await settle();
  expect(token.isCancellationRequested).toBe(true);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(toasts()).toHaveLength(1);
  task.resolve('done');
  expect(await result).toBe('done');
  await settle();
  expect(toasts()).toEqual([]);
});

test('reports are throttled but the last one shows, and a task that throws takes its progress away', async () => {
  const finished = deferred<void>();
  let reporter!: vscode.Progress<{ message?: string }>;
  void progress.withProgress('a', { location: ProgressLocation.Window, title: 'Indexing' }, value => {
    reporter = value;
    return finished.promise;
  });
  await settle();
  for (let index = 1; index <= 50; index++) {
    reporter.report({ message: 'file ' + index });
  }
  await new Promise(resolve => setTimeout(resolve, 150));
  await settle();
  const [record] = entries.values();
  expect(record.entry.text).toBe('$(loading~spin) Indexing: file 50');
  // Fifty reports in one task: the first goes at once, the rest merge into one at the end of the interval.
  expect(record.updates).toBeLessThanOrEqual(2);

  const failure = new Error('task failed');
  const thrown = progress.withProgress('a', { location: ProgressLocation.Notification, title: 'Failing' }, async () => {
    await settle();
    throw failure;
  });
  await expect(thrown).rejects.toBe(failure);
  await settle();
  expect(toasts()).toEqual([]);
  finished.resolve();
  await settle();
  expect(record.disposed).toBe(true);
});

test('status bar messages stack, and go after their timeout or promise', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
  const done = deferred<void>();
  progress.setStatusBarMessage('a', 'Saved', 1000);
  const second = progress.setStatusBarMessage('a', '$(sync~spin) Syncing', done.promise);
  await settle();
  const record = entries.get('status.extensionMessage')!;
  expect(record.entry.text).toBe('$(sync~spin) Syncing');
  done.resolve();
  await settle();
  expect(record.entry.text).toBe('Saved');
  vi.advanceTimersByTime(1000);
  await settle();
  expect(record.disposed).toBe(true);
  second.dispose();
});

test('a waiting progress toast is never dropped by a flood from its source', () => {
  for (let index = 0; index < 3; index++) {
    notifications.notify({ severity: Severity.Error, message: 'Visible ' + index, source: 'Flood' });
  }
  const progressToast = notifications.notify({ severity: Severity.Info, message: 'Working', source: 'Flood', progress: { infinite: true } });
  for (let index = 0; index < 60; index++) {
    notifications.notify({ severity: Severity.Info, message: 'Waiting ' + index, source: 'Flood' });
  }
  expect(progressToast.closed).toBe(false);
  expect(toasts().map(toast => toast.getAttribute('aria-label'))).toEqual(['Visible 0', 'Visible 1', 'Visible 2']);
  toasts()[0].querySelector<HTMLButtonElement>('[aria-label="Dismiss message"]')!.click();
  expect(toasts().at(-1)?.getAttribute('aria-label')).toBe('Working');
});
