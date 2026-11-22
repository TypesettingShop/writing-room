import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { KeyChord, KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { formatKeybinding } from '../../../../../base/common/keybindingLabels.js';
import { parseKeybinding } from '../../../../../base/common/keybindingParser.js';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import * as monaco from '../../../../../editor/browser/monaco.js';
import { CodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import type { ICodeEditor } from '../../../../../editor/browser/services/codeEditorService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
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
  ['ctrl+numpad_add', 'Ctrl+NumpadAdd'],
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
let editors: CodeEditorService;
let target: HTMLDivElement;
let input: HTMLInputElement;

beforeEach(() => {
  store = new DisposableStore();
  root = store.add(new ContextKeyService());
  editors = store.add(new CodeEditorService());
  execute = vi.fn().mockResolvedValue(undefined);
  service = store.add(new WorkbenchKeybindingService({
    _serviceBrand: undefined,
    async executeCommand<T>(id: string, ...args: unknown[]): Promise<T> {
      return await execute(id, ...args) as T;
    },
  }, root, editors));
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

function registerEditorContainer(): void {
  editors.addCodeEditor({ getContainerDomNode: () => target } as unknown as ICodeEditor);
  target.append(input);
}

test('lets Monaco finish an unmatched chord with its original prefix inside a registered editor', () => {
  bind('chord', 'ctrl+shift+k ctrl+s');
  registerEditorContainer();
  const forward = vi.spyOn(monaco, 'forwardMonacoChordPrefix').mockReturnValue(true);
  const received = vi.fn();
  input.addEventListener('keydown', received);
  const modifiers = { ctrlKey: true, shiftKey: true };

  expect(press(input, 'KeyK', modifiers).defaultPrevented).toBe(true);
  const second = press(input, 'KeyX', { ctrlKey: true });
  expect(second.defaultPrevented).toBe(true);
  expect(forward).toHaveBeenCalledExactlyOnceWith(parseKeybinding('ctrl+shift+k')!.chords[0], second, input);

  // A Monaco command that keeps the default action still keeps the key from the editor's widgets.
  forward.mockReturnValue(false);
  press(input, 'KeyK', modifiers);
  expect(press(input, 'KeyX', { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(received).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

test('keeps a mismatched continuation swallowed when Monaco declines it or the event cannot bubble there', () => {
  bind('chord', 'ctrl+k ctrl+s');
  registerEditorContainer();
  const forward = vi.spyOn(monaco, 'forwardMonacoChordPrefix').mockReturnValue(undefined);
  const received = vi.fn();
  input.addEventListener('keydown', received);
  const ctrl = { ctrlKey: true };

  press(input, 'KeyK', ctrl);
  expect(press(input, 'KeyX', ctrl).defaultPrevented).toBe(true);
  expect(received).not.toHaveBeenCalled();
  expect(forward).toHaveBeenCalledOnce();

  forward.mockClear();
  press(input, 'KeyK', ctrl);
  expect(press(input, 'KeyX', { ...ctrl, bubbles: false }).defaultPrevented).toBe(true);
  expect(forward).not.toHaveBeenCalled();
});

test('keeps extension chord matches and outside-editor mismatches out of Monaco', () => {
  bind('extension-chord', 'ctrl+k ctrl+x', { weight: KeybindingWeight.ExternalExtension });
  registerEditorContainer();
  const forward = vi.spyOn(monaco, 'forwardMonacoChordPrefix').mockReturnValue(true);
  const outside = document.createElement('input');
  document.body.append(outside);
  const ctrl = { ctrlKey: true };

  press(input, 'KeyK', ctrl);
  expect(press(input, 'KeyX', ctrl).defaultPrevented).toBe(true);
  expect(execute).toHaveBeenCalledExactlyOnceWith('extension-chord');

  press(outside, 'KeyK', ctrl);
  expect(press(outside, 'KeyC', ctrl).defaultPrevented).toBe(true);
  expect(forward).not.toHaveBeenCalled();
});

test('composition cancels a pending chord without forwarding it', () => {
  bind('chord', 'ctrl+k ctrl+s');
  registerEditorContainer();
  const forward = vi.spyOn(monaco, 'forwardMonacoChordPrefix').mockReturnValue(true);
  const ctrl = { ctrlKey: true };

  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    press(input, 'KeyK', ctrl);
    expect(press(input, 'KeyX', { ...ctrl, ...composition }).defaultPrevented).toBe(false);
    expect(press(input, 'KeyS', ctrl).defaultPrevented).toBe(false);
  }
  expect(forward).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

test('runs a composition-safe shortcut only in its scoped context and discards any pending chord', () => {
  bind('safe', 'ctrl+s');
  bind('chord', 'ctrl+k ctrl+s');
  bind('other', 'ctrl+x');
  target.addEventListener('keydown', event => service.dispatchDuringComposition(event, ['safe']));
  const ctrl = { ctrlKey: true };
  const composing = { ...ctrl, isComposing: true };
  expect(press(input, 'KeyS', composing).defaultPrevented).toBe(false);
  expect(press(target, 'KeyX', composing).defaultPrevented).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  expect(press(target, 'KeyK', ctrl).defaultPrevented).toBe(true);
  expect(press(target, 'KeyS', composing).defaultPrevented).toBe(true);
  expect(execute).toHaveBeenCalledExactlyOnceWith('safe');
  expect(press(target, 'KeyS', ctrl).defaultPrevented).toBe(true);
  expect(execute.mock.calls).toEqual([['safe'], ['safe']]);
});

test('swallows an unmatched editor continuation before Monaco has loaded', () => {
  bind('chord', 'ctrl+k ctrl+s');
  registerEditorContainer();
  press(input, 'KeyK', { ctrlKey: true });
  expect(press(input, 'KeyX', { ctrlKey: true }).defaultPrevented).toBe(true);
});

test('completes a chord whose second stroke is a plain letter while typing in a text input', () => {
  bind('zen', 'ctrl+k z');
  input.focus();
  expect(press(input, 'KeyK', { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(press(input, 'KeyZ', { key: 'z' }).defaultPrevented).toBe(true);
  expect(execute).toHaveBeenCalledExactlyOnceWith('zen');
  expect(press(input, 'KeyZ', { key: 'z' }).defaultPrevented).toBe(false);
  expect(execute).toHaveBeenCalledOnce();
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
