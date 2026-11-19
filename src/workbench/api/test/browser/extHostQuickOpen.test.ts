import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { BrowserLayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { QuickInputService } from '../../../../platform/quickinput/browser/quickInputService.js';
import { MainThreadQuickOpen } from '../../browser/mainThreadQuickOpen.js';
import { ExtHostQuickOpenProxy, MainThreadQuickOpenProxy } from '../../common/extHost.protocol.windowUi.js';
import { ExtHostQuickOpen, InputBoxValidationSeverity, QuickInputButtons, QuickPickItemKind } from '../../common/extHostQuickOpen.js';
import { createDomRpcPair, settle } from './windowUiTestRpc.js';

let pair: ReturnType<typeof createDomRpcPair>;
let quickInput: QuickInputService;
let main: MainThreadQuickOpen;
let host: ExtHostQuickOpen;
let previous: HTMLTextAreaElement;

beforeEach(() => {
  quickInput = new QuickInputService(new BrowserLayoutService());
  pair = createDomRpcPair();
  main = new MainThreadQuickOpen(pair.main.getProxy(ExtHostQuickOpenProxy), quickInput, key => key === 'a' || key === 'b');
  pair.main.set(MainThreadQuickOpenProxy, main);
  host = new ExtHostQuickOpen(pair.worker.getProxy(MainThreadQuickOpenProxy));
  pair.worker.set(ExtHostQuickOpenProxy, host);
  previous = document.createElement('textarea');
  document.body.append(previous);
  previous.focus();
});

afterEach(() => {
  host.dispose();
  main.dispose();
  quickInput.dispose();
  pair.dispose();
  document.body.replaceChildren();
});

const field = () => document.querySelector<HTMLInputElement>('.wr-quick-input input');
const options = () => [...document.querySelectorAll<HTMLElement>('[role=option]')];
const active = () => document.querySelector<HTMLElement>('[role=option][aria-selected=true]')?.textContent;

function press(key: string, init: KeyboardEventInit = {}): void {
  field()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}

function type(value: string): void {
  field()!.value = value;
  field()!.dispatchEvent(new Event('input', { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('a pick returns the very object the extension gave, and only its text crosses to the workbench', async () => {
  // A function cannot be cloned: if the item itself crossed, the pick would never show.
  const items = [{ label: 'One', run: () => 1 }, { label: 'Two', description: 'second', run: () => 2 }];
  const selected: unknown[] = [];
  const result = host.showQuickPick('a', items, { placeHolder: 'Choose', onDidSelectItem: item => selected.push(item) });
  await settle();
  expect(field()?.getAttribute('aria-label')).toBe('Choose');
  expect(options().map(option => option.textContent)).toEqual(['One ', 'Two second']);
  press('ArrowDown');
  await settle();
  press('Enter');
  expect(await result).toBe(items[1]);
  expect(selected).toEqual([items[0], items[1]]);
  expect(document.activeElement).toBe(previous);

  const strings = host.showQuickPick('a', ['red', 'green'], undefined);
  await settle();
  press('Enter');
  expect(await strings).toBe('red');
});

test('many picks return an array that starts from the picked items, and separators cannot be chosen', async () => {
  const items: vscode.QuickPickItem[] = [
    { label: 'Fruit', kind: QuickPickItemKind.Separator },
    { label: 'Apple', picked: true },
    { label: 'Pear' },
    { label: 'Vegetables', kind: QuickPickItemKind.Separator },
    { label: 'Leek' },
  ];
  const result = host.showQuickPick('a', items, { canPickMany: true });
  await settle();
  expect(options().map(option => [option.textContent, option.getAttribute('aria-checked')]))
    .toEqual([['Apple ', 'true'], ['Pear ', 'false'], ['Leek ', 'false']]);
  expect(document.querySelector('[role=group][aria-label=Vegetables]')).not.toBeNull();
  press('ArrowUp');
  press(' ', { ctrlKey: true });
  await settle();
  press('Enter');
  const many = await result as vscode.QuickPickItem[];
  expect(many).toEqual([items[1], items[4]]);
  expect(many[0]).toBe(items[1]);

  const untouched = host.showQuickPick('a', items, { canPickMany: true });
  await settle();
  press('Enter');
  expect(await untouched).toEqual([items[1]]);
});

test('alwaysShow items survive the filter, and the description matches only when asked', async () => {
  const items = [{ label: 'Alpha', description: 'first' }, { label: 'Beta', alwaysShow: true }, { label: 'Gamma' }];
  const pick = host.showQuickPick('a', items, { matchOnDescription: true });
  await settle();
  type('first');
  expect(options().map(option => option.textContent)).toEqual(['Alpha first', 'Beta ']);
  type('zzz');
  expect(options().map(option => option.textContent)).toEqual(['Beta ']);
  press('Escape');
  expect(await pick).toBeUndefined();

  const plain = host.showQuickPick('a', items, undefined);
  await settle();
  type('first');
  expect(options().map(option => option.textContent)).toEqual(['Beta ']);
  press('Escape');
  await plain;
});

test('Escape and focus moving away end with undefined, unless the input ignores focus out', async () => {
  const other = document.createElement('button');
  document.body.append(other);
  const escaped = host.showInputBox('a', { value: 'draft' });
  await settle();
  press('Escape');
  expect(await escaped).toBeUndefined();
  expect(document.activeElement).toBe(previous);

  const moved = host.showQuickPick('a', ['one'], undefined);
  await settle();
  other.focus();
  expect(await moved).toBeUndefined();
  expect(document.activeElement).toBe(other);

  previous.focus();
  const kept = host.showQuickPick('a', ['one'], { ignoreFocusOut: true });
  let settled = false;
  void kept.then(() => { settled = true; });
  await settle();
  other.focus();
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();
  expect(settled).toBe(false);
  expect(field()).not.toBeNull();
  field()!.focus();
  press('Escape');
  expect(await kept).toBeUndefined();
});

test('cancelling the token closes the pick and the input box', async () => {
  const source = new CancellationTokenSource();
  const pick = host.showQuickPick('a', ['one'], undefined, source.token);
  await settle();
  expect(field()).not.toBeNull();
  source.cancel();
  expect(await pick).toBeUndefined();
  await settle();
  expect(field()).toBeNull();

  const cancelled = new CancellationTokenSource();
  cancelled.cancel();
  expect(await host.showInputBox('a', undefined, cancelled.token)).toBeUndefined();
  await settle();
  expect(field()).toBeNull();
});

test('a validation result for an older value neither shows nor accepts', async () => {
  const late = deferred<string | undefined>();
  const result = host.showInputBox('a', {
    value: 'old',
    validateInput: value => value === 'old' ? late.promise
      : value === 'new' ? 'New value is invalid'
        : value === 'warn' ? { message: 'Only a warning', severity: InputBoxValidationSeverity.Warning } : undefined,
  });
  let done = false;
  void result.then(() => { done = true; });
  await settle();
  press('Enter');
  await settle();
  type('new');
  await settle();
  expect(document.querySelector('[role=status]')?.textContent).toBe('New value is invalid');
  expect(field()!.getAttribute('aria-invalid')).toBe('true');
  // The late result passes: it must not accept 'old' nor clear the message of 'new'.
  late.resolve(undefined);
  await settle();
  expect(done).toBe(false);
  expect(document.querySelector('[role=status]')?.textContent).toBe('New value is invalid');

  press('Enter');
  await settle();
  expect(done).toBe(false);
  type('warn');
  await settle();
  expect(document.querySelector('[role=status]')?.textContent).toBe('Only a warning');
  expect(field()!.getAttribute('aria-invalid')).toBe('false');
  press('Enter');
  expect(await result).toBe('warn');
});

test('a second quick input ends the first with undefined, across extensions too', async () => {
  const first = host.showQuickPick('a', ['one'], undefined);
  await settle();
  const second = host.showInputBox('b', { prompt: 'Name' });
  expect(await first).toBeUndefined();
  await settle();
  expect(document.querySelectorAll('.wr-quick-input')).toHaveLength(1);
  type('mine');
  press('Enter');
  expect(await second).toBe('mine');
  expect(document.activeElement).toBe(previous);
});

test('items replaced while showing keep the highlighted item, and a late list is not applied after hiding', async () => {
  const pick = host.createQuickPick('a');
  const [a, b, c] = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];
  pick.items = [a, b, c];
  pick.show();
  await settle();
  press('ArrowDown');
  press('ArrowDown');
  await settle();
  expect(pick.activeItems).toEqual([c]);
  pick.items = [{ label: 'New' }, a, b, c];
  await settle();
  expect(active()).toBe('C ');
  expect(pick.activeItems).toEqual([c]);
  pick.dispose();

  const list = deferred<string[]>();
  const late = host.showQuickPick('a', list.promise, undefined);
  await settle();
  expect(document.querySelector<HTMLElement>('.wr-quick-input-progress')?.hidden).toBe(false);
  press('Escape');
  expect(await late).toBeUndefined();
  list.resolve(['arrived']);
  await settle();
  expect(field()).toBeNull();
});

test('a value the user typed before the extension set its own does not undo the extension', async () => {
  const pick = host.createQuickPick('a');
  const values: string[] = [];
  pick.onDidChangeValue(value => values.push(value));
  pick.items = [{ label: 'x' }, { label: 'y' }];
  pick.show();
  await settle();
  type('typed');
  pick.value = 'set';
  await settle();
  expect(pick.value).toBe('set');
  expect(field()!.value).toBe('set');
  expect(values).toEqual([]);
  type('set more');
  await settle();
  expect(values).toEqual(['set more']);
  pick.dispose();
});

test('buttons report the button object, and Back is QuickInputButtons.Back', async () => {
  const box = host.createInputBox('a');
  const help = { iconPath: { id: 'question' } as vscode.ThemeIcon, tooltip: 'Help' };
  const pressed: vscode.QuickInputButton[] = [];
  box.onDidTriggerButton(button => pressed.push(button));
  box.title = 'Step';
  box.step = 2;
  box.totalSteps = 3;
  box.buttons = [QuickInputButtons.Back, help];
  box.show();
  await settle();
  expect(document.querySelector('.wr-quick-input-steps')?.textContent).toBe('2/3');
  document.querySelector<HTMLElement>('[aria-label=Back]')!.click();
  document.querySelector<HTMLElement>('[aria-label=Help]')!.click();
  await settle();
  expect(pressed).toEqual([QuickInputButtons.Back, help]);
  box.dispose();
});

test('removing an extension closes its quick inputs on both sides', async () => {
  const pick = host.showQuickPick('a', ['one'], undefined);
  await settle();
  main.remove('a');
  expect(field()).toBeNull();
  expect(document.activeElement).toBe(previous);
  host.release('a');
  expect(await pick).toBeUndefined();

  const box = host.createInputBox('b');
  const hidden = vi.fn();
  box.onDidHide(hidden);
  box.show();
  await settle();
  host.release('b');
  expect(hidden).toHaveBeenCalledOnce();
  await settle();
  expect(field()).toBeNull();
  box.show();
  await settle();
  expect(field()).toBeNull();
});

test('a password input box hides its value and an unregistered extension shows nothing', async () => {
  const secret = host.showInputBox('a', { password: true, value: 'hunter2' });
  await settle();
  expect(field()!.type).toBe('password');
  press('Escape');
  await secret;

  void host.showQuickPick('unknown', ['one'], undefined);
  await settle();
  expect(field()).toBeNull();
});
