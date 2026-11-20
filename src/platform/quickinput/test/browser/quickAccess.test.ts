import { afterEach, beforeEach, expect, test } from 'vitest';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { BrowserLayoutService } from '../../../layout/browser/layoutService.js';
import { QuickAccessController } from '../../browser/quickAccess.js';
import { QuickInputService } from '../../browser/quickInputService.js';
import { QuickAccessRegistry } from '../../common/quickAccess.js';
import type { IQuickAccessProvider } from '../../common/quickAccess.js';
import type { IQuickPick, IQuickPickItem } from '../../common/quickInput.js';

interface Turn {
  readonly picker: IQuickPick<IQuickPickItem>;
  readonly token: CancellationToken;
  disposed: boolean;
  readonly values: string[];
}

/** A provider that lists fixed items and records each turn it is given. */
class RecordingProvider implements IQuickAccessProvider {
  readonly turns: Turn[] = [];

  constructor(private readonly labels: readonly string[]) {}

  provide(picker: IQuickPick<IQuickPickItem>, token: CancellationToken): IDisposable {
    const turn: Turn = { picker, token, disposed: false, values: [] };
    this.turns.push(turn);
    picker.items = this.labels.map(label => ({ label }));
    const listener = picker.onDidChangeValue(value => turn.values.push(value));
    return toDisposable(() => {
      turn.disposed = true;
      listener.dispose();
    });
  }
}

let service: QuickInputService;
let registry: QuickAccessRegistry;
let controller: QuickAccessController;
let symbols: RecordingProvider;
let previous: HTMLTextAreaElement;

beforeEach(() => {
  service = new QuickInputService(new BrowserLayoutService());
  registry = new QuickAccessRegistry();
  symbols = new RecordingProvider(['#heading', 'alpha', 'beta']);
  const instances = new Map<unknown, IQuickAccessProvider>([[RecordingProvider, symbols]]);
  controller = new QuickAccessController(service, {
    createInstance: (ctor: unknown) => instances.get(ctor) ?? new (ctor as new () => IQuickAccessProvider)(),
  } as never, registry);
  registry.registerQuickAccessProvider({
    ctor: RecordingProvider, prefix: '#', placeholder: 'Type the name of a symbol to open.',
    helpEntries: [{ description: 'Go to Symbol in Workspace' }],
  });
  previous = document.createElement('textarea');
  document.body.append(previous);
  previous.focus();
});

afterEach(() => {
  service.dispose();
  document.body.replaceChildren();
});

const field = () => document.querySelector<HTMLInputElement>('.wr-quick-input input')!;
const rows = () => [...document.querySelectorAll('[role=option]')].map(row => row.querySelector('.wr-quick-input-label')!.textContent);

function type(value: string): void {
  field().value = value;
  field().dispatchEvent(new Event('input', { bubbles: true }));
}

function press(key: string): void {
  field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

test('the registry picks the longest prefix and refuses a prefix twice', () => {
  const other = registry.registerQuickAccessProvider({ ctor: RecordingProvider, prefix: '#!', helpEntries: [] });
  expect(registry.getQuickAccessProvider('#!x')?.prefix).toBe('#!');
  expect(registry.getQuickAccessProvider('#x')?.prefix).toBe('#');
  expect(registry.getQuickAccessProvider('x')).toBeUndefined();
  expect(() => registry.registerQuickAccessProvider({ ctor: RecordingProvider, prefix: '#', helpEntries: [] })).toThrow();
  other.dispose();
  expect(registry.getQuickAccessProvider('#!x')?.prefix).toBe('#');
});

test('show opens one pick with the value and the caret after the prefix, and the provider fills it', () => {
  controller.show('#');
  expect(field().value).toBe('#');
  expect(field()).toBe(document.activeElement);
  expect([field().selectionStart, field().selectionEnd]).toEqual([1, 1]);
  expect(field().placeholder).toBe('Type the name of a symbol to open.');
  expect(symbols.turns).toHaveLength(1);
  expect(rows()).toEqual(['#heading', 'alpha', 'beta']);
});

test('the prefix is taken off once before filtering', () => {
  controller.show('#');
  type('#al');
  expect(rows()).toEqual(['alpha']);
  type('##');
  expect(rows()).toEqual(['#heading']);
  expect(symbols.turns).toHaveLength(1);
  expect(symbols.turns[0].values).toEqual(['#al', '##']);
});

test('leaving the prefix ends the provider and shows help; choosing help starts it once again', () => {
  controller.show('#');
  const first = symbols.turns[0];
  type('');
  expect(first.disposed).toBe(true);
  expect(first.token.isCancellationRequested).toBe(true);
  expect(rows()).toEqual(['#']);
  expect(document.querySelector('[role=option] .wr-quick-input-description')?.textContent).toBe('Go to Symbol in Workspace');
  type('abc');
  expect(rows()).toEqual(['#']);
  press('Enter');
  expect(field().value).toBe('#');
  expect([field().selectionStart, field().selectionEnd]).toEqual([1, 1]);
  expect(symbols.turns).toHaveLength(2);
  expect(rows()).toEqual(['#heading', 'alpha', 'beta']);
  type('#a');
  // The ended turn hears nothing more; the new one hears each value once.
  expect(first.values).toEqual([]);
  expect(symbols.turns[1].values).toEqual(['#a']);
  expect(symbols.turns).toHaveLength(2);
});

test('Escape ends the provider, cancels its token and gives focus back', () => {
  controller.show('#');
  const turn = symbols.turns[0];
  press('Escape');
  expect(turn.disposed).toBe(true);
  expect(turn.token.isCancellationRequested).toBe(true);
  expect(document.querySelector('.wr-quick-input')).toBeNull();
  expect(document.activeElement).toBe(previous);
  controller.show('#');
  expect(symbols.turns).toHaveLength(2);
  expect(document.querySelectorAll('.wr-quick-input')).toHaveLength(1);
});

test('showing again while shown changes the value only; another quick input replaces it', async () => {
  controller.show('#al');
  controller.show('#');
  expect(document.querySelectorAll('.wr-quick-input')).toHaveLength(1);
  expect(field().value).toBe('#');
  expect(symbols.turns).toHaveLength(1);

  const pick = service.pick([{ label: 'Other' }]);
  expect(symbols.turns[0].disposed).toBe(true);
  press('Escape');
  await expect(pick).resolves.toBeUndefined();
  expect(document.activeElement).toBe(previous);

  // The palette open first is replaced by quick access, and focus still goes back to where it was.
  const palette = service.pick([{ label: 'Command' }]);
  controller.show('#');
  await expect(palette).resolves.toBeUndefined();
  expect(field().value).toBe('#');
  press('Escape');
  expect(document.activeElement).toBe(previous);
});

test('a quick pick filters with its value as is unless filterValue says otherwise', () => {
  const picker = service.createQuickPick<IQuickPickItem>();
  picker.items = [{ label: '#one' }, { label: 'one' }, { label: 'two' }];
  picker.value = '#o';
  picker.show();
  expect(field().value).toBe('#o');
  expect([field().selectionStart, field().selectionEnd]).toEqual([0, 2]);
  expect(rows()).toEqual(['#one']);
  picker.filterValue = value => value.slice(1);
  expect(rows()).toEqual(['#one', 'one', 'two']);
  type('#tw');
  expect(rows()).toEqual(['two']);
  picker.dispose();
});

test('the service creates its quick access controller once, with its instantiation service', () => {
  expect(service.quickAccess).toBe(service.quickAccess);
});
