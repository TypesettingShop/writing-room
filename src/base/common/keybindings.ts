import { KeyMod, keyCodeLabel } from './keyCodes.js';
import type { KeyCode } from './keyCodes.js';

export type KeybindingPlatform = 'mac' | 'win' | 'linux';

export function getKeybindingPlatform(platform: string): KeybindingPlatform {
  if (/mac|iphone|ipad/i.test(platform)) {
    return 'mac';
  }
  return /win/i.test(platform) ? 'win' : 'linux';
}

export class KeyCodeChord {
  constructor(
    readonly ctrlKey: boolean,
    readonly shiftKey: boolean,
    readonly altKey: boolean,
    readonly metaKey: boolean,
    readonly keyCode: KeyCode,
  ) {}

  equals(other: KeyCodeChord): boolean {
    return this.keyCode === other.keyCode && this.ctrlKey === other.ctrlKey
      && this.shiftKey === other.shiftKey && this.altKey === other.altKey && this.metaKey === other.metaKey;
  }
}

export class Keybinding {
  constructor(readonly chords: readonly [KeyCodeChord] | readonly [KeyCodeChord, KeyCodeChord]) {}
}

function decodeChord(value: number, platform: KeybindingPlatform): KeyCodeChord | undefined {
  const key = value & 0xff;
  if (!keyCodeLabel(key) || (value & ~0xfff) !== 0) {
    return undefined;
  }
  const ctrlCmd = Boolean(value & KeyMod.CtrlCmd);
  const winCtrl = Boolean(value & KeyMod.WinCtrl);
  return new KeyCodeChord(
    platform === 'mac' ? winCtrl : ctrlCmd,
    Boolean(value & KeyMod.Shift),
    Boolean(value & KeyMod.Alt),
    platform === 'mac' ? ctrlCmd : winCtrl,
    key,
  );
}

export function decodeKeybinding(value: number, platform: KeybindingPlatform): Keybinding | undefined {
  if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) {
    return undefined;
  }
  const first = decodeChord(value & 0xffff, platform);
  if (!first) {
    return undefined;
  }
  const tail = value >>> 16;
  if (!tail) {
    return new Keybinding([first]);
  }
  const second = decodeChord(tail, platform);
  return second && new Keybinding([first, second]);
}
