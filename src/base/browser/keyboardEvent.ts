import { isPrintableKeyCode, keyCodeFromCode } from '../common/keyCodes.js';
import { KeyCodeChord } from '../common/keybindings.js';

export class StandardKeyboardEvent {
  readonly chord: KeyCodeChord | undefined;
  readonly mightType: boolean;

  constructor(readonly browserEvent: KeyboardEvent) {
    const { code, ctrlKey, shiftKey, altKey, metaKey } = browserEvent;
    const key = keyCodeFromCode(code);
    this.chord = key === undefined ? undefined : new KeyCodeChord(ctrlKey, shiftKey, altKey, metaKey, key);
    const altGraph = browserEvent.getModifierState('AltGraph');
    this.mightType = (altGraph || (!ctrlKey && !metaKey)) && key !== undefined && isPrintableKeyCode(key);
  }
}
