import { expect, test, vi } from 'vitest';
import type { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { FieldInput } from '../fieldInputs.js';

test('routes Ctrl+S during preedit to the embedding editor’s save command', () => {
  const change = vi.fn();
  const dispatchDuringComposition = vi.fn();
  const input = new FieldInput(document, 'text', { change },
    { dispatchDuringComposition } as unknown as IKeybindingService, { saveCommandId: 'test.save' });
  try {
    input.control.dispatchEvent(new CompositionEvent('compositionstart'));
    input.control.value = '한';
    const key = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, isComposing: true });
    input.control.dispatchEvent(key);
    expect(change).toHaveBeenCalledExactlyOnceWith('한');
    expect(dispatchDuringComposition).toHaveBeenCalledExactlyOnceWith(key, ['test.save']);
  } finally {
    input.dispose();
  }
});
