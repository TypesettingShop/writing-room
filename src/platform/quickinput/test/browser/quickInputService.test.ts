import { afterEach, beforeEach, expect, test } from 'vitest';
import { BrowserLayoutService } from '../../../layout/browser/layoutService.js';
import { getQuickInputFocus } from '../../browser/quickInputController.js';
import { QuickInputService } from '../../browser/quickInputService.js';

let service: QuickInputService;
let previous: HTMLTextAreaElement;

beforeEach(() => {
  service = new QuickInputService(new BrowserLayoutService());
  previous = document.createElement('textarea');
  document.body.append(previous);
  previous.focus();
});

afterEach(() => {
  service.dispose();
  document.body.replaceChildren();
});

function field(): HTMLInputElement {
  return document.querySelector('input')!;
}

function press(key: string, isComposing = false): void {
  field().dispatchEvent(new KeyboardEvent('keydown', { key, isComposing, bubbles: true, cancelable: true }));
}

test('replacing a pick and an input settles both and preserves the original focus', async () => {
  previous.value = 'writing';
  previous.setSelectionRange(2, 5);
  const item = { label: 'First' };
  const pick = service.pick([item]);
  const input = service.input({ value: 'second' });
  const finalPick = service.pick([item]);
  await expect(pick).resolves.toBeUndefined();
  await expect(input).resolves.toBeUndefined();
  expect(document.querySelectorAll('input')).toHaveLength(1);
  press('Enter', true);
  expect(field()).toBe(document.activeElement);
  press('Enter');
  await expect(finalPick).resolves.toBe(item);
  expect(document.activeElement).toBe(previous);
  expect([previous.selectionStart, previous.selectionEnd]).toEqual([2, 5]);
});

test('a page hide and service disposal settle active calls', async () => {
  const pick = service.pick([{ label: 'One' }]);
  window.dispatchEvent(new Event('pagehide'));
  await expect(pick).resolves.toBeUndefined();
  expect(document.querySelector('input')).toBeNull();
  const input = service.input();
  service.dispose();
  await expect(input).resolves.toBeUndefined();
  await expect(service.input()).resolves.toBeUndefined();
});

test('a late validation result cannot clear or accept a newer value', async () => {
  let finishPrevious!: (message: string | undefined) => void;
  const previousValidation = new Promise<string | undefined>(resolve => { finishPrevious = resolve; });
  const result = service.input({
    value: 'old',
    validateInput: value => value === 'old' ? previousValidation : value === 'new' ? 'New value is invalid' : undefined,
  });
  let settled = false;
  void result.then(() => { settled = true; });

  press('Enter');
  field().value = 'new';
  field().dispatchEvent(new Event('input', { bubbles: true }));
  finishPrevious(undefined);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  expect(document.querySelector('[role=status]')?.textContent).toBe('New value is invalid');

  field().value = 'newer';
  field().dispatchEvent(new Event('input', { bubbles: true }));
  press('Enter');
  await expect(result).resolves.toBe('newer');
});

test('presses and Tab inside keep focus in the input, and focus moved elsewhere cancels and stays there', async () => {
  const other = document.createElement('button');
  document.body.append(other);
  const pick = service.pick([{ label: 'One' }], { title: 'Choose' });
  const titlePress = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  document.querySelector('.wr-quick-input-title')!.dispatchEvent(titlePress);
  expect(titlePress.defaultPrevented).toBe(true);
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  field().dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);

  other.focus();
  await expect(pick).resolves.toBeUndefined();
  expect(document.querySelector('input')).toBeNull();
  expect(document.activeElement).toBe(other);
});

test('a press that starts in the input and ends outside does not cancel, and a click outside does', async () => {
  const input = service.input({ value: 'kept' });
  field().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(field()).toBe(document.activeElement);

  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await expect(input).resolves.toBeUndefined();
  expect(document.activeElement).toBe(previous);
});

test('while a quick input has focus, the focus it reports is the element it will return to', async () => {
  const pick = service.pick([{ label: 'One' }]);
  expect(document.activeElement).toBe(field());
  expect(getQuickInputFocus(document)).toBe(previous);
  press('Escape');
  await expect(pick).resolves.toBeUndefined();
});
