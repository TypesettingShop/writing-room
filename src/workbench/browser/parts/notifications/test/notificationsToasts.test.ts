import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Severity } from '../../../../../platform/notification/common/notification.js';
import type { INotificationAction } from '../../../../../platform/notification/common/notification.js';
import { NotificationsToasts, toastAutoCloseDelay } from '../notificationsToasts.js';

let layout: HTMLElement;
let toasts: NotificationsToasts;
let windowFocused: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  windowFocused = true;
  layout = document.createElement('main');
  document.body.append(layout);
  toasts = new NotificationsToasts(layout, () => windowFocused);
});

afterEach(() => {
  toasts.dispose();
  layout.remove();
  vi.useRealTimers();
});

const info = (message: string, actions?: INotificationAction[]) => toasts.add({ severity: Severity.Info, message, actions });
const error = (message: string) => toasts.add({ severity: Severity.Error, message });
const progress = (message: string) => toasts.add({ severity: Severity.Info, message, progress: { infinite: true } });
const shown = () => [...layout.querySelectorAll<HTMLElement>('section[aria-label]')];
const labels = () => shown().map(item => item.getAttribute('aria-label'));
const dismiss = (item: HTMLElement) => item.querySelector<HTMLButtonElement>('button[aria-label="Dismiss message"]')!;
const advance = (ms = toastAutoCloseDelay) => vi.advanceTimersByTime(ms);

function withHitTest(hitTest: (x: number, y: number) => Element | null, run: () => void): void {
  // jsdom delivers pointer events but has no layout or hit testing.
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hitTest });
  try {
    run();
  } finally {
    Reflect.deleteProperty(document, 'elementFromPoint');
  }
}

function movePointer(x: number): void {
  layout.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: x }));
}

test('closes plain information at ten seconds through the ordinary close event', () => {
  const handle = info('Initial');
  const ignored = toasts.add({ severity: Severity.Ignore, message: 'Ignored' });
  const onClose = vi.fn();
  handle.onDidClose(onClose);
  advance(9_999);
  handle.updateMessage('Updated');
  expect(labels()).toEqual(['Updated', 'Ignored']);

  advance(1);
  expect(labels()).toEqual([]);
  expect(ignored.closed).toBe(true);
  expect(handle.closed).toBe(true);
  handle.close();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('warnings, errors, questions and progress stay until explicitly closed', () => {
  const run = vi.fn();
  const question = info('Question', [{ label: 'Yes', run }]);
  const warning = toasts.add({ severity: Severity.Warning, message: 'Warning' });
  const failure = error('Error');
  advance(toastAutoCloseDelay * 2);
  expect(labels()).toEqual(['Question', 'Warning', 'Error']);

  failure.close();
  const working = toasts.add({
    severity: Severity.Info, message: 'Working', progress: { worked: 50 },
    actions: [{ label: 'Cancel', keepOpen: true, run }],
  });
  shown().at(-1)!.querySelector<HTMLButtonElement>('.extension-toast-actions button')!.click();
  expect(run).toHaveBeenCalledTimes(1);
  advance(toastAutoCloseDelay * 2);
  expect(labels()).toEqual(['Question', 'Warning', 'Working']);
  for (const handle of [question, warning, working]) {
    expect(handle.closed).toBe(false);
  }
  expect(vi.getTimerCount()).toBe(0);
});

test('changing actions or progress stops the timer and becoming eligible starts a fresh one', () => {
  const handle = info('Dynamic');
  advance(toastAutoCloseDelay - 1);
  handle.updateActions([{ label: 'Yes', run() {} }]);
  expect(vi.getTimerCount()).toBe(0);
  advance();
  expect(handle.closed).toBe(false);

  handle.updateActions([]);
  advance(toastAutoCloseDelay - 1);
  handle.updateProgress({ worked: 42 });
  expect(vi.getTimerCount()).toBe(0);
  advance();
  expect(handle.closed).toBe(false);

  handle.updateProgress(undefined);
  advance(toastAutoCloseDelay - 1);
  expect(handle.closed).toBe(false);
  advance(1);
  expect(handle.closed).toBe(true);
});

test('starts a full delay when the window regains focus', () => {
  const handle = info('Focused');
  advance(toastAutoCloseDelay - 1);
  windowFocused = false;
  window.dispatchEvent(new FocusEvent('blur'));
  advance(toastAutoCloseDelay * 2);
  expect(handle.closed).toBe(false);
  expect(vi.getTimerCount()).toBe(0);

  windowFocused = true;
  window.dispatchEvent(new FocusEvent('focus'));
  advance(toastAutoCloseDelay - 1);
  expect(handle.closed).toBe(false);
  advance(1);
  expect(handle.closed).toBe(true);
});

test('tries again when focus has moved out of the toast', () => {
  const handle = info('Focused');
  dismiss(shown()[0]).focus();
  advance();
  expect(handle.closed).toBe(false);

  dismiss(shown()[0]).blur();
  advance(toastAutoCloseDelay - 1);
  expect(handle.closed).toBe(false);
  advance(1);
  expect(handle.closed).toBe(true);
});

test('uses the current hit beneath an unmoved pointer after the stack shifts', () => {
  const first = toasts.add({ severity: Severity.Warning, message: 'First' });
  const second = toasts.add({ severity: Severity.Warning, message: 'Second' });
  const third = info('Third');
  withHitTest(x => x === 1 ? shown()[1] ?? null : null, () => {
    movePointer(1);
    first.close();
    advance();
    expect(third.closed).toBe(false);
    error('First error');
    error('Second error');
    expect(labels()).toEqual(['Third', 'First error', 'Second error']);
    expect(second.closed).toBe(false);
    movePointer(0);
    advance();
    expect(third.closed).toBe(true);
    expect(labels()).toEqual(['First error', 'Second error', 'Second']);
  });
});

test('starts the full delay on first display and restarts it when a displaced toast returns', () => {
  const first = error('First error');
  const second = error('Second error');
  const third = error('Third error');
  const waiting = info('Waiting');
  advance(toastAutoCloseDelay * 2);
  expect(labels()).toEqual(['First error', 'Second error', 'Third error']);
  expect(waiting.closed).toBe(false);

  third.close();
  const node = shown()[2];
  advance(toastAutoCloseDelay - 1);
  const urgent = progress('Working');
  expect(labels()).toEqual(['First error', 'Second error', 'Working']);
  expect(vi.getTimerCount()).toBe(0);
  advance(toastAutoCloseDelay * 2);
  expect(waiting.closed).toBe(false);

  urgent.close();
  expect(shown()[2]).toBe(node);
  advance(toastAutoCloseDelay - 1);
  expect(waiting.closed).toBe(false);
  advance(1);
  expect(waiting.closed).toBe(true);
  first.close();
  second.close();
});

test('displaces the latest ordinary toast, keeps live updates and restores the waiting order', () => {
  const answer = vi.fn();
  info('First');
  info('Second');
  const third = info('Third', [{ label: 'Choose', run: answer }]);
  const retained = shown();
  const onClose = vi.fn();
  third.onDidClose(onClose);
  info('Fourth');
  const urgent = error('Error');
  expect(labels()).toEqual(['First', 'Second', 'Error']);
  expect(shown().slice(0, 2)).toEqual(retained.slice(0, 2));
  expect(onClose).not.toHaveBeenCalled();
  third.updateMessage('Updated third');
  third.updateProgress({ worked: 60 });
  expect(labels()).toEqual(['First', 'Error', 'Updated third']);
  urgent.close();
  expect(labels()).toEqual(['First', 'Updated third', 'Second']);
  expect(shown()[1]).toBe(retained[2]);
  expect(shown()[1].querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('60');
  const choose = shown()[1].querySelector<HTMLButtonElement>('.extension-toast-actions button')!;
  choose.click();
  choose.click();
  expect(answer).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(labels()).toEqual(['First', 'Second', 'Fourth']);
});

test('gives urgent toasts the next slot in arrival order when all visible toasts are urgent', () => {
  const first = error('First error');
  const second = progress('First task');
  error('Second error');
  info('Waiting info');
  const third = progress('Second task');
  const fourth = error('Third error');
  expect(labels()).toEqual(['First error', 'First task', 'Second error']);
  first.close();
  expect(labels()).toEqual(['First task', 'Second error', 'Second task']);
  second.close();
  expect(labels()).toEqual(['Second error', 'Second task', 'Third error']);
  third.close();
  expect(labels()).toEqual(['Second error', 'Third error', 'Waiting info']);
  expect(fourth.closed).toBe(false);
});

test('holds a hovered or focused toast and rechecks as the user leaves it', async () => {
  error('First error');
  progress('Working');
  info('Question', [{ label: 'Yes', run() {} }]);
  const question = shown()[2];
  const button = dismiss(question);
  button.focus();

  withHitTest(x => x === 1 ? question : null, () => {
    movePointer(1);
    error('Waiting error');
    expect(labels()).toEqual(['First error', 'Working', 'Question']);
    expect(document.activeElement).toBe(button);
    movePointer(0);
    expect(labels()).toEqual(['First error', 'Working', 'Question']);
  });

  const action = question.querySelector<HTMLButtonElement>('.extension-toast-actions button')!;
  action.focus();
  await Promise.resolve();
  expect(labels()).toEqual(['First error', 'Working', 'Question']);
  expect(document.activeElement).toBe(action);
  action.blur();
  await Promise.resolve();
  expect(labels()).toEqual(['First error', 'Working', 'Waiting error']);
});

test('keeps a toast whose own button gains focus when the focus change runs microtasks first', async () => {
  error('First error');
  progress('Working');
  info('Question', [{ label: 'Yes', run() {} }]);
  const question = shown()[2];
  const button = dismiss(question);
  const action = question.querySelector<HTMLButtonElement>('.extension-toast-actions button')!;
  button.focus();
  error('Waiting error');
  expect(labels()).toEqual(['First error', 'Working', 'Question']);
  // Chromium runs the focusout microtask while activeElement is still the body.
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document.body });
  try {
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: action }));
    await Promise.resolve();
    expect(labels()).toEqual(['First error', 'Working', 'Question']);
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    await Promise.resolve();
    expect(labels()).toEqual(['First error', 'Working', 'Waiting error']);
  } finally {
    Reflect.deleteProperty(document, 'activeElement');
  }
});

test('a toast is urgent while it shows progress', () => {
  error('First error');
  error('Second error');
  const task = info('Task');
  task.updateProgress({ worked: 10 });
  error('Third error');
  expect(labels()).toEqual(['First error', 'Second error', 'Task']);
  task.updateProgress(undefined);
  expect(labels()).toEqual(['First error', 'Second error', 'Third error']);
  expect(task.closed).toBe(false);
});

test('a queued toast takes priority as soon as progress is added', () => {
  info('First');
  info('Second');
  info('Third');
  const task = info('Queued task');
  expect(labels()).toEqual(['First', 'Second', 'Third']);
  task.updateProgress({ worked: 10 });
  expect(labels()).toEqual(['First', 'Second', 'Queued task']);
});

test('an action that updates the actions keeps keyboard focus in its toast', () => {
  error('First error');
  progress('Working');
  let handle: ReturnType<typeof info> | undefined;
  handle = info('Question', [{ label: 'Next', keepOpen: true, run: () => handle!.updateActions([{ label: 'Done', run() {} }]) }]);
  const question = shown()[2];
  question.querySelector<HTMLButtonElement>('.extension-toast-actions button')!.focus();
  error('Waiting error');
  question.querySelector<HTMLButtonElement>('.extension-toast-actions button')!.click();
  expect(document.activeElement?.textContent).toBe('Done');
  expect(labels()).toEqual(['First error', 'Working', 'Question']);
});

test('new actions for a closed toast are ignored', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const handle = toasts.add({ severity: Severity.Warning, message: 'Closed' });
    handle.close();
    handle.updateActions([{ label: 'Late', run() {} }]);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test('gives a waiting error the slot when the pointer leaves the window', () => {
  error('First error');
  progress('Working');
  info('Hovered');
  const hovered = shown()[2];
  withHitTest(() => hovered, () => {
    movePointer(1);
    error('Waiting error');
    expect(labels()).toEqual(['First error', 'Working', 'Hovered']);
    layout.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
    expect(labels()).toEqual(['First error', 'Working', 'Waiting error']);
  });
});

test('checks the latest pointer position once per frame while an urgent toast is waiting', () => {
  error('First error');
  progress('Working');
  info('Hovered');
  const hovered = shown()[2];
  const hit = vi.fn((x: number) => x === 1 ? hovered : null);
  withHitTest(hit, () => {
    movePointer(1);
    error('Waiting error');
    hit.mockClear();
    movePointer(2);
    movePointer(1);
    advance(16);
    expect(hit).toHaveBeenCalledExactlyOnceWith(1, 0);
    expect(labels()).toEqual(['First error', 'Working', 'Hovered']);
    movePointer(2);
    advance(16);
    expect(labels()).toEqual(['First error', 'Working', 'Waiting error']);
  });
});

test('a source flood evicts older waiting toasts without closing a displaced toast', () => {
  error('First error');
  error('Second error');
  const send = (message: string) => toasts.add({ severity: Severity.Info, message, source: 'Flood' });
  const displaced = send('Shown');
  const urgent = progress('Working');
  const queued = Array.from({ length: 12 }, (_, index) => send('Waiting ' + index));
  expect(displaced.closed).toBe(false);
  expect(queued.slice(0, 3).map(toast => toast.closed)).toEqual([true, true, true]);
  expect(queued.slice(3).every(toast => !toast.closed)).toBe(true);
  urgent.close();
  expect(labels()).toEqual(['First error', 'Second error', 'Shown']);
});

test('a displacement from another source preserves questions waiting at the queue limit', () => {
  error('First error');
  error('Second error');
  const notice = toasts.add({ severity: Severity.Warning, message: 'Shown from A', source: 'A' });
  const answer = vi.fn();
  const question = toasts.add({
    severity: Severity.Info, message: 'Question from A', source: 'A', actions: [{ label: 'Yes', run: answer }],
  });
  const ordinary = Array.from({ length: 9 }, (_, index) =>
    toasts.add({ severity: Severity.Info, message: 'From A ' + index, source: 'A' }));
  const urgent = toasts.add({ severity: Severity.Error, message: 'Urgent from B', source: 'B' });
  expect(question.closed).toBe(false);
  expect(ordinary[0].closed).toBe(true);
  urgent.close();
  notice.close();
  expect(labels()).toEqual(['First error', 'Second error', 'Question from A']);
  shown()[2].querySelector<HTMLButtonElement>('.extension-toast-actions button')!.click();
  expect(answer).toHaveBeenCalledTimes(1);
});

test('closing visible and displaced toasts and disposing leaves no scheduled closes', () => {
  const first = info('First');
  info('Second');
  const third = info('Third');
  const onClose = vi.fn();
  third.onDidClose(onClose);
  error('Error');
  expect(vi.getTimerCount()).toBe(2);
  first.close();
  expect(labels()).toEqual(['Second', 'Error', 'Third']);
  progress('Working');
  expect(labels()).toEqual(['Second', 'Error', 'Working']);
  third.close();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  toasts.dispose();
  expect(vi.getTimerCount()).toBe(0);
  advance();
  expect(labels()).toEqual([]);
  expect(onClose).toHaveBeenCalledTimes(1);
});
