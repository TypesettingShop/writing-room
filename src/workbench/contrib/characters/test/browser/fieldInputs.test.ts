import { expect, test, vi } from 'vitest';
import { Emitter, Event } from '../../../../../base/common/event.js';
import type { CharacterTemplate } from '../../../../../platform/characters/common/characterFields.js';
import type { CharacterEntry } from '../../../../../platform/characters/common/characters.js';
import type { CharactersStore } from '../../../../../platform/characters/common/charactersStore.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { ICharactersService } from '../../../../services/characters/common/charactersService.js';
import type { IFileDialogService } from '../../../../services/dialogs/common/dialogs.js';
import { CharacterEditorInput } from '../../browser/characterEditorInput.js';
import { CharacterEditorPane } from '../../browser/characterEditorPane.js';
import type { CharactersViewState } from '../../browser/charactersViewState.js';
import { FieldInput } from '../../../../browser/fieldCard/fieldInputs.js';

test('exposes the label and description, forwards composing Ctrl+S, and leaves preedit in its control', () => {
  const change = vi.fn();
  const dispatch = vi.fn();
  const input = new FieldInput(document, 'longText', { change }, { dispatchDuringComposition: dispatch } as unknown as IKeybindingService);
  try {
    input.update({ label: '목표', placeholder: '무엇을 원하는가' });
    expect(input.element.querySelector('label')!.htmlFor).toBe(input.control.id);
    const describedBy = input.control.getAttribute('aria-describedby');
    expect(input.element.querySelector('#' + describedBy)?.textContent).toBe('무엇을 원하는가');

    input.control.dispatchEvent(new CompositionEvent('compositionstart'));
    input.control.value = '한';
    input.setValue('Another window');
    expect(input.control.value).toBe('한');
    const save = new KeyboardEvent('keydown', { key: 's', isComposing: true, ctrlKey: true });
    input.control.dispatchEvent(save);
    expect(change).toHaveBeenCalledExactlyOnceWith('한');
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(save, ['workbench.action.files.save']);
  } finally {
    input.dispose();
  }
});

test('a template change event updates the pane without replacing focused preedit or discarding obsolete values', async () => {
  const node: CharacterEntry = {
    id: 'character', kind: 'character', parentId: null, position: 0, title: 'Rin', type: 'unknown',
    values: { old: 'Keep', role: 'Retired' }, createdAt: 0, updatedAt: 0,
  };
  const parent = document.body.appendChild(document.createElement('div'));
  const goal = { id: 'goal', kind: 'longText', label: 'Goal' };
  const role = { id: 'role', kind: 'choice', label: 'Role', options: ['Lead'] };
  let fields: CharacterTemplate = [goal, role];
  const onDidChangeTemplate = new Emitter<string>();
  const characters = {
    onDidChangeTemplate: onDidChangeTemplate.event,
    store: { getTemplate: async () => ({ fields, revision: 1 }) } as unknown as CharactersStore,
  } as ICharactersService;
  const input = new CharacterEditorInput('work', node.id, { node, revision: 1 },
    { onDidChangeTree: Event.None } as unknown as CharactersViewState, characters, {} as IDialogService,
    {} as IFileDialogService, {} as INotificationService);
  const pane = new CharacterEditorPane(characters, {} as IKeybindingService);
  try {
    pane.create(parent);
    await pane.setInput(input, undefined);
    const control = parent.querySelector('textarea')!;
    const select = parent.querySelector('select')!;
    expect(select.value).toBe('Retired');
    control.focus();
    control.dispatchEvent(new CompositionEvent('compositionstart'));
    control.value = '한';

    fields = [{ id: 'new', kind: 'text', label: 'New field' }, { ...goal, label: 'New goal' }, role];
    onDidChangeTemplate.fire('work');
    await Promise.resolve();
    expect(parent.textContent).not.toContain('New field');
    expect(document.activeElement).toBe(control);
    expect(control.value).toBe('한');

    control.dispatchEvent(new CompositionEvent('compositionend'));
    expect(parent.textContent).toContain('New field');
    expect(parent.querySelector('textarea')).toBe(control);
    expect(document.activeElement).toBe(control);
    expect(control.value).toBe('한');
    expect(input.model?.draft.values).toEqual({ goal: '한', old: 'Keep', role: 'Retired' });
  } finally {
    pane.dispose();
    input.dispose();
    onDidChangeTemplate.dispose();
    parent.remove();
  }
});
