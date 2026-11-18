import { expect, test } from 'vitest';
import { createWordMatcher } from '../../common/filters.js';

test('requires every query term, in either field and in any order', () => {
  const match = createWordMatcher('  TaB\tWORK  ');
  expect(match('Workspace: Close Tab', 'document')).toEqual([
    [{ start: 0, end: 4 }, { start: 17, end: 20 }], [],
  ]);
  expect(match('Tab', 'my workspace')).toEqual([
    [{ start: 0, end: 3 }], [{ start: 3, end: 7 }],
  ]);
  expect(match('Tab', 'document')).toBeUndefined();
});

test('returns original UTF-16 offsets, merges overlaps and treats punctuation literally', () => {
  expect(createWordMatcher('Bab aba')('📁ababa')).toEqual([[{ start: 2, end: 6 }]]);
  expect(createWordMatcher('[A+B]')('Open [a+b] file')).toEqual([[{ start: 5, end: 10 }]]);
  expect(createWordMatcher('a+b')('aaaab')).toBeUndefined();
  expect(createWordMatcher('   ')('Open', '')).toEqual([[], []]);
});
