import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { KeyChord, KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { formatKeybinding } from '../../../../../base/common/keybindingLabels.js';
import { parseKeybinding } from '../../../../../base/common/keybindingParser.js';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { IKeybindingRule } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeybindingResolver, ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { WorkbenchKeybindingService } from '../../browser/keybindingService.js';

test.each([
  ['ctrl+shift+p', 'Ctrl+Shift+P'],
  ['f1', 'F1'],
  ['alt+f4', 'Alt+F4'],
  ['ctrl+k ctrl+s', 'Ctrl+K Ctrl+S'],
  ['ctrl+;', 'Ctrl+;'],
  ['win+q', 'Windows+Q'],
])('parses %s as %s', (text, label) => {
  expect(formatKeybinding(parseKeybinding(text)!, 'win')).toBe(label);
});

test.each(['ctrl', 'hyper+x', 'ctrl++x', 'ctrl+ctrl+x', 'cmd+win+x', 'ctrl+nonesuch', 'a b c'])(
  'rejects the malformed keybinding %s', text => expect(parseKeybinding(text)).toBeUndefined(),
);

test('formats numeric modifiers and platform replacements', () => {
  const numeric = KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP;
  const chord = KeyChord(numeric, KeyMod.WinCtrl | KeyCode.KeyS);
  expect(formatKeybinding(decodeKeybinding(chord, 'linux')!, 'linux')).toBe('Ctrl+Shift+P Super+S');
  expect(formatKeybinding(decodeKeybinding(chord, 'mac')!, 'mac')).toBe('⇧⌘P ⌃S');
  expect(formatKeybinding(decodeKeybinding(chord, 'mac')!, 'mac', true)).toBe('Shift+Command+P Control+S');

  const rules = [{ id: 'override', key: 'f3', weight: 0, mac: { key: 'cmd+m' }, win: { primary: 0 } }];
  expect(formatKeybinding(new KeybindingResolver(rules, 'mac').lookupKeybinding('override')!, 'mac')).toBe('⌘M');
  expect(formatKeybinding(new KeybindingResolver(rules, 'linux').lookupKeybinding('override')!, 'linux')).toBe('F3');
  expect(new KeybindingResolver(rules, 'win').lookupKeybinding('override')).toBeUndefined();
});

let store: DisposableStore;
let root: ContextKeyService;
let execute: Mock<(id: string, ...args: unknown[]) => Promise<unknown>>;
let service: WorkbenchKeybindingService;
let target: HTMLDivElement;
let input: HTMLInputElement;

beforeEach(() => {
  store = new DisposableStore();
  root = store.add(new ContextKeyService());
  execute = vi.fn().mockResolvedValue(undefined);
  service = store.add(new WorkbenchKeybindingService({
    _serviceBrand: undefined,
    async executeCommand<T>(id: string, ...args: unknown[]): Promise<T> {
      return await execute(id, ...args) as T;
    },
  }, root));
  target = document.createElement('div');
  target.tabIndex = 0;
  input = document.createElement('input');
  document.body.append(target, input);
});

afterEach(() => {
  store.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function bind(id: string, key: string, extra: Partial<IKeybindingRule> = {}) {
  return store.add(KeybindingsRegistry.registerKeybindingRule({ id, key, weight: 0, ...extra }));
}

function press(element: HTMLElement, code: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, ...options });
  element.dispatchEvent(event);
  return event;
}

test('uses the focused scope, weight, id ordering and registration ordering, and passes args', () => {
  const scope = store.add(root.createScoped(target));
  const view = scope.createKey<string>('view', 'draft');
  const received = vi.fn();
  target.addEventListener('keydown', received);

  bind('fallback', 'f3', { weight: 100, args: [1, 2] });
  bind('z-last-id', 'f3', { weight: 200, args: 'older', when: ContextKeyExpr.equals('view', 'draft') });
  const newest = bind('z-last-id', 'f3', { weight: 200, args: 'newer', when: ContextKeyExpr.equals('view', 'draft') });
  bind('a-recent-id', 'f3', { weight: 200, when: ContextKeyExpr.equals('view', 'draft') });
  bind('overweight-but-hidden', 'f3', { weight: 300, when: ContextKeyExpr.false() });

  expect(press(target, 'F3').defaultPrevented).toBe(true);
  expect(received).not.toHaveBeenCalled();
  expect(execute).toHaveBeenLastCalledWith('z-last-id', 'newer');
  newest.dispose();
  press(target, 'F3');
  expect(execute).toHaveBeenLastCalledWith('z-last-id', 'older');
  view.set('other');
  press(target, 'F3');
  expect(execute).toHaveBeenLastCalledWith('fallback', [1, 2]);
  expect(press(target, 'F4').defaultPrevented).toBe(false);
  expect(received).toHaveBeenCalledTimes(1);
});

test('swallows a chord prefix and a mismatched continuation, and times out after 5000 ms', () => {
  vi.useFakeTimers();
  bind('chord', 'ctrl+k ctrl+s');
  bind('mismatch-alone', 'f4');
  const ctrl = { ctrlKey: true };

  expect(press(target, 'KeyK', ctrl).defaultPrevented).toBe(true);
  vi.advanceTimersByTime(4999);
  expect(press(target, 'KeyS', ctrl).defaultPrevented).toBe(true);
  expect(execute).toHaveBeenCalledExactlyOnceWith('chord');
  execute.mockClear();

  press(target, 'KeyK', ctrl);
  vi.advanceTimersByTime(5000);
  expect(press(target, 'KeyS', ctrl).defaultPrevented).toBe(false);
  expect(execute).not.toHaveBeenCalled();

  press(target, 'KeyK', ctrl);
  expect(press(target, 'F4').defaultPrevented).toBe(true);
  expect(execute).not.toHaveBeenCalled();
  press(target, 'F4');
  expect(execute).toHaveBeenCalledExactlyOnceWith('mismatch-alone');
});

test('tracks inputFocus and protects typing and composition while dispatching modified physical keys', () => {
  bind('plain', 'x');
  bind('modified', 'ctrl+x', { when: ContextKeyExpr.has('inputFocus') });
  const textbox = document.createElement('div');
  textbox.setAttribute('role', 'textbox');
  const wrapper = document.createElement('span');
  wrapper.tabIndex = 0;
  textbox.append(wrapper);
  target.append(textbox);
  wrapper.focus();
  expect(root.getContextKeyValue('inputFocus')).toBe(true);
  input.focus();
  expect(press(input, 'KeyX', { key: 'x' }).defaultPrevented).toBe(false);
  expect(press(input, 'KeyX', { isComposing: true, ctrlKey: true }).defaultPrevented).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  expect(press(input, 'KeyX', { key: 'q', ctrlKey: true }).defaultPrevented).toBe(true);
  expect(execute).toHaveBeenCalledExactlyOnceWith('modified');
  target.focus();
  expect(root.getContextKeyValue('inputFocus')).toBe(false);
  press(target, 'KeyX');
  expect(execute).toHaveBeenLastCalledWith('plain');
});

test('updates lookup after registration and disposal, skipping and reporting invalid bindings', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const updated = vi.fn();
  store.add(service.onDidUpdateKeybindings(updated));
  bind('label', 'ctrl+f3');
  const highest = bind('label', 'alt+f4', { weight: 100 });
  const invalid = bind('broken', 'wrong');
  expect(service.lookupKeybinding('label')?.getLabel()).toBe('Alt+F4');
  expect(service.lookupKeybinding('broken')).toBeUndefined();
  expect(error).toHaveBeenCalledExactlyOnceWith("Invalid keybinding for 'broken': wrong");
  highest.dispose();
  invalid.dispose();
  expect(service.lookupKeybinding('label')?.getAriaLabel()).toBe('Control+F3');
  expect(updated).toHaveBeenCalledTimes(5);
});

test('chooses the highest priority rule when a single binding shares a chord prefix', () => {
  const single = { id: 'single', key: 'ctrl+k', weight: 0 };
  const chord = { id: 'chord', key: 'ctrl+k ctrl+s', weight: 0 };
  const [first, second] = parseKeybinding(chord.key)!.chords;
  expect(new KeybindingResolver([single, chord], 'linux').resolve(root.getContext(null), first).kind)
    .toBe(ResultKind.MoreChordsNeeded);
  expect(new KeybindingResolver([single, chord], 'linux').resolve(root.getContext(null), first, second))
    .toEqual({ kind: ResultKind.KbFound, rule: chord });
  expect(new KeybindingResolver([chord, single], 'linux').resolve(root.getContext(null), first))
    .toEqual({ kind: ResultKind.KbFound, rule: single });
});
