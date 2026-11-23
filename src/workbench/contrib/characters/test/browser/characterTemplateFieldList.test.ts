import { expect, test, vi } from 'vitest';
import { newTemplateFieldId } from '../../browser/characterTemplateFieldList.js';

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
