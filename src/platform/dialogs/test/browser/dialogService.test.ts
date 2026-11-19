import { afterEach, beforeEach, expect, test } from 'vitest';
import { Severity } from '../../../../base/common/severity.js';
import { BrowserLayoutService } from '../../../layout/browser/layoutService.js';
import { DialogService } from '../../browser/dialogService.js';

let service: DialogService;
let behind: HTMLButtonElement;
let previous: HTMLTextAreaElement;

beforeEach(() => {
  service = new DialogService(new BrowserLayoutService());
  const workbench = document.createElement('div');
  behind = document.createElement('button');
  previous = document.createElement('textarea');
  workbench.append(behind, previous);
  document.body.append(workbench);
  previous.focus();
});

afterEach(() => {
  document.body.replaceChildren();
});

const dialog = () => document.querySelector<HTMLElement>('[role=dialog]');
const buttons = () => [...dialog()!.querySelectorAll('button')];

function key(key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

test('a dialog is modal, keeps focus inside and gives it back when it closes', async () => {
  const { result } = service.prompt({
    type: Severity.Warning, message: 'Delete <b>notes</b>?', detail: 'This cannot be undone.', source: 'Fixture',
    buttons: ['Delete', 'Keep'], cancelButton: 1,
  });
  const element = dialog()!;
  expect(element.getAttribute('aria-modal')).toBe('true');
  expect(document.getElementById(element.getAttribute('aria-labelledby')!)?.textContent).toBe('Delete <b>notes</b>?');
  expect(element.querySelector('b')).toBeNull();
  expect(element.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent))
    .toEqual(['This cannot be undone.', 'Source: Fixture']);
  expect(behind.parentElement!.hasAttribute('inert')).toBe(true);
  expect(document.activeElement).toBe(buttons()[0]);

  expect(key('Tab').defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(buttons()[1]);
  key('Tab');
  expect(document.activeElement).toBe(buttons()[0]);
  key('Tab', true);
  expect(document.activeElement).toBe(buttons()[1]);
  behind.focus();
  expect(document.activeElement).toBe(buttons()[0]);

  key('Escape');
  await expect(result).resolves.toBe(1);
  expect(dialog()).toBeNull();
  expect(behind.parentElement!.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(previous);
});

test('Escape without a cancel button chooses nothing, and dialogs wait their turn', async () => {
  const first = service.prompt({ type: Severity.Info, message: 'First', buttons: ['OK'] });
  const skipped = service.prompt({ type: Severity.Info, message: 'Skipped', buttons: ['OK'] });
  const second = service.prompt({ type: Severity.Error, message: 'Second', buttons: ['Retry', 'Close'] });
  expect(document.querySelectorAll('[role=dialog]')).toHaveLength(1);
  skipped.close();
  await expect(skipped.result).resolves.toBeUndefined();
  key('Escape');
  await expect(first.result).resolves.toBeUndefined();
  expect(dialog()?.textContent).toContain('Second');
  buttons()[1].click();
  await expect(second.result).resolves.toBe(1);
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(previous);
});
