// Numeric keybindings use the VS Code / Monaco key code assignments.
export enum KeyCode {
  Unknown = 0,
  Backspace = 1, Tab = 2, Enter = 3,
  PauseBreak = 7, CapsLock = 8, Escape = 9, Space = 10, PageUp = 11, PageDown = 12,
  End = 13, Home = 14, LeftArrow = 15, UpArrow = 16, RightArrow = 17, DownArrow = 18,
  Insert = 19, Delete = 20,
  Digit0 = 21, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9,
  KeyA = 31, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM,
  KeyN, KeyO, KeyP, KeyQ, KeyR, KeyS, KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ,
  ContextMenu = 58,
  F1 = 59, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12,
  F13, F14, F15, F16, F17, F18, F19, F20, F21, F22, F23, F24,
  NumLock = 83, ScrollLock = 84,
  Semicolon = 85, Equal, Comma, Minus, Period, Slash, Backquote, BracketLeft, Backslash, BracketRight, Quote,
  IntlBackslash = 97,
  Numpad0 = 98, Numpad1, Numpad2, Numpad3, Numpad4, Numpad5, Numpad6, Numpad7, Numpad8, Numpad9,
  NumpadMultiply = 108, NumpadAdd = 109, NUMPAD_SEPARATOR = 110,
  NumpadSubtract = 111, NumpadDecimal = 112, NumpadDivide = 113,
}

export enum KeyMod {
  CtrlCmd = 0x800,
  Shift = 0x400,
  Alt = 0x200,
  WinCtrl = 0x100,
}

export function KeyChord(first: number, second: number): number {
  return ((first & 0xffff) | ((second & 0xffff) << 16)) >>> 0;
}

const punctuation = new Map<KeyCode, string>([
  [KeyCode.Semicolon, ';'], [KeyCode.Equal, '='], [KeyCode.Comma, ','], [KeyCode.Minus, '-'],
  [KeyCode.Period, '.'], [KeyCode.Slash, '/'], [KeyCode.Backquote, '`'], [KeyCode.BracketLeft, '['],
  [KeyCode.Backslash, '\\'], [KeyCode.BracketRight, ']'], [KeyCode.Quote, "'"],
]);
const names = new Map<KeyCode, string>();
const aliases = new Map<string, KeyCode>();
const physicalCodes = new Map<string, KeyCode>();
const physicalNames = new Map<KeyCode, string>([
  [KeyCode.PauseBreak, 'Pause'], [KeyCode.LeftArrow, 'ArrowLeft'], [KeyCode.UpArrow, 'ArrowUp'],
  [KeyCode.RightArrow, 'ArrowRight'], [KeyCode.DownArrow, 'ArrowDown'], [KeyCode.NUMPAD_SEPARATOR, 'NumpadComma'],
]);

for (const value of Object.values(KeyCode)) {
  if (typeof value !== 'number' || value === KeyCode.Unknown) {
    continue;
  }
  const name = KeyCode[value];
  const label = punctuation.get(value) ?? name.replace(/^(Key|Digit)/, '').replace(/Arrow$/, '');
  const code = physicalNames.get(value) ?? name;
  names.set(value, label);
  physicalCodes.set(code, value);
  for (const alias of [name, label, code]) {
    aliases.set(alias.toLowerCase(), value);
  }
}
aliases.set('esc', KeyCode.Escape);
aliases.set('return', KeyCode.Enter);
aliases.set('del', KeyCode.Delete);
physicalCodes.set('NumpadEnter', KeyCode.Enter);

export function keyCodeFromName(name: string): KeyCode | undefined { return aliases.get(name.toLowerCase()); }
export function keyCodeFromCode(code: string): KeyCode | undefined { return physicalCodes.get(code); }
export function keyCodeLabel(keyCode: KeyCode): string | undefined { return names.get(keyCode); }

export function isPrintableKeyCode(keyCode: KeyCode): boolean {
  return keyCode === KeyCode.Space
    || (keyCode >= KeyCode.Digit0 && keyCode <= KeyCode.KeyZ)
    || (keyCode >= KeyCode.Semicolon && keyCode <= KeyCode.NumpadDivide);
}
