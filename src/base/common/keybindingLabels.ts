import { KeyCode, keyCodeLabel } from './keyCodes.js';
import type { Keybinding, KeybindingPlatform } from './keybindings.js';

const macArrows = new Map([
  [KeyCode.LeftArrow, '←'], [KeyCode.UpArrow, '↑'], [KeyCode.RightArrow, '→'], [KeyCode.DownArrow, '↓'],
]);

export function formatKeybinding(binding: Keybinding, platform: KeybindingPlatform, aria = false): string {
  const mac = platform === 'mac';
  const symbols = mac && !aria;
  const meta = mac ? 'Command' : platform === 'win' ? 'Windows' : 'Super';
  const modifierLabels = symbols ? ['⌃', '⇧', '⌥', '⌘']
    : [aria ? 'Control' : 'Ctrl', 'Shift', mac ? 'Option' : 'Alt', meta];

  return binding.chords.map(chord => {
    const modifiers = [chord.ctrlKey, chord.shiftKey, chord.altKey, chord.metaKey];
    const labels = modifierLabels.filter((_, index) => modifiers[index]);
    labels.push((symbols ? macArrows.get(chord.keyCode) : undefined) ?? keyCodeLabel(chord.keyCode) ?? '');
    return labels.join(symbols ? '' : '+');
  }).join(' ');
}
