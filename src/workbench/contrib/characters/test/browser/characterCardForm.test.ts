import { expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { CharacterCardForm } from '../../browser/characterCardForm.js';
import { CharacterCardModel } from '../../browser/characterCardModel.js';

test('names the warning and shows incompatible multiline text until the writer types a replacement', () => {
  const disposables = new DisposableStore();
  const parent = document.body.appendChild(document.createElement('section'));
  const saved = 'White coat\nBlue scarf';
  const model = disposables.add(new CharacterCardModel('work', {
    id: 'character', kind: 'character', parentId: null, position: 0, title: 'Rin', type: 'unknown',
    values: { appearance: saved }, createdAt: 0, updatedAt: 0,
  }, 0, { updateNode: vi.fn(), checkTemplateChanges: vi.fn() },
  async () => undefined, { _serviceBrand: undefined, prompt: vi.fn() }, {} as INotificationService));
  const form = disposables.add(new CharacterCardForm(parent, model, {} as IKeybindingService));
  try {
    form.setTemplate([{ id: 'appearance', label: 'Appearance', kind: 'text' }]);
    const warning = parent.querySelector<HTMLParagraphElement>('[role="status"][aria-label="Invalid saved value for Appearance"]')!;
    const original = parent.querySelector<HTMLTextAreaElement>('textarea[aria-label="Original value for Appearance"]')!;
    const replace = parent.querySelector<HTMLButtonElement>('button[aria-label="Replace value for Appearance"]')!;
    const replacement = parent.querySelector<HTMLInputElement>('.character-card-field input')!;
    expect(warning.hidden).toBe(false);
    expect(original.readOnly).toBe(true);
    expect(original.value).toBe(saved);
    expect(replacement.parentElement!.hidden).toBe(true);
    expect(model.dirty).toBe(false);

    replace.click();
    expect(document.activeElement).toBe(replacement);
    expect(replacement.value).toBe('');
    expect(model.draft.values.appearance).toBe(saved);
    replacement.value = 'Grey coat';
    replacement.dispatchEvent(new Event('input', { bubbles: true }));
    expect(model.draft.values.appearance).toBe('Grey coat');
    expect(parent.contains(warning)).toBe(false);
    expect(parent.contains(original)).toBe(false);
    expect(replacement.value).toBe('Grey coat');
  } finally {
    disposables.dispose();
    parent.remove();
  }
});
