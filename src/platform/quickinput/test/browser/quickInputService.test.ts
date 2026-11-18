import { afterEach, beforeEach, expect, test } from 'vitest';
import { BrowserLayoutService } from '../../../layout/browser/layoutService.js';
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

test('a late validation result cannot block or accept a newer value', async () => {
  let finishPrevious!: (message: string) => void;
  const previousValidation = new Promise<string>(resolve => { finishPrevious = resolve; });
  const result = service.input({ value: 'old', validateInput: value => value === 'old' ? previousValidation : undefined });

  press('Enter');
  field().value = 'new';
  field().dispatchEvent(new Event('input', { bubbles: true }));
  finishPrevious('Old value is invalid');
  await previousValidation;
  expect(document.querySelector('[role=status]')?.textContent).toBe('');

  press('Enter');
  await expect(result).resolves.toBe('new');
});
