import { keyCodeFromName } from './keyCodes.js';
import { Keybinding, KeyCodeChord } from './keybindings.js';

const modifiers = new Map([
  ['ctrl', 'ctrl'], ['shift', 'shift'], ['alt', 'alt'], ['meta', 'meta'], ['cmd', 'meta'], ['win', 'meta'],
]);

function parseChord(text: string): KeyCodeChord | undefined {
  const parts = text.toLowerCase().split('+');
  const keyCode = keyCodeFromName(parts.pop() ?? '');
  if (keyCode === undefined) {
    return undefined;
  }
  const active = new Set<string>();
  for (const part of parts) {
    const modifier = modifiers.get(part);
    if (!modifier || active.has(modifier)) {
      return undefined;
    }
    active.add(modifier);
  }
  return new KeyCodeChord(active.has('ctrl'), active.has('shift'), active.has('alt'), active.has('meta'), keyCode);
}

export function parseKeybinding(text: string): Keybinding | undefined {
  const [head, tail, ...rest] = text.trim().split(/\s+/);
  const first = parseChord(head);
  if (!first || rest.length) {
    return undefined;
  }
  if (!tail) {
    return new Keybinding([first]);
  }
  const second = parseChord(tail);
  return second && new Keybinding([first, second]);
}
