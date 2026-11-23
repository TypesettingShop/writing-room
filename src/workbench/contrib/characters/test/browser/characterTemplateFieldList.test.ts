import { expect, test, vi } from 'vitest';
import type { CharacterValues } from '../../../../../platform/characters/common/characterFields.js';
import type { CharacterNode } from '../../../../../platform/characters/common/characters.js';
import { newTemplateFieldId, readFieldValueCount } from '../../browser/characterTemplateFieldList.js';

test('reserves default template IDs and values left by removed fields when choosing a new ID', () => {
  const generate = vi.fn<() => string>()
    .mockReturnValueOnce('bad id')
    .mockReturnValueOnce('appearance')
    .mockReturnValueOnce('removed_field')
    .mockReturnValueOnce('current_field')
    .mockReturnValueOnce('new_field');
  expect(newTemplateFieldId(new Set(['removed_field', 'current_field']), generate)).toBe('new_field');
  expect(generate).toHaveBeenCalledTimes(5);
});

test('counts nonempty values, including whitespace, and distinguishes unknown from zero', async () => {
  const base = { id: 'id', parentId: null, title: '', position: 0, createdAt: 0, updatedAt: 0 };
  const examples: CharacterValues[] = [{ appearance: 'Coat' }, { appearance: ' ' }, { appearance: '' }, { role: 'Lead' }];
  const nodes: CharacterNode[] = [
    { ...base, kind: 'folder' },
    ...examples.map(values => ({ ...base, kind: 'character' as const, type: 'unknown' as const, values })),
  ];
  const store = { getTree: vi.fn(async () => ({ revision: 0, nodes })) };
  await expect(readFieldValueCount(store, 'work', 'appearance')).resolves.toBe(2);
  await expect(readFieldValueCount(store, 'work', 'absent')).resolves.toBe(0);
  store.getTree.mockRejectedValueOnce(new Error('Unavailable'));
  await expect(readFieldValueCount(store, 'work', 'appearance')).resolves.toBeUndefined();
});
