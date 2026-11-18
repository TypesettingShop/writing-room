import { describe, expect, test } from 'vitest';
import { getTabDropIndex, isAfterTabMiddle } from '../../../../browser/parts/editor/multiEditorTabsControl.js';

describe('getTabDropIndex', () => {
  // Tabs A B C D at 0 1 2 3; the result is `moveEditor`'s index, counted after the move.
  test('a tab moving right within its group lands one lower, where the marker showed', () => {
    expect(getTabDropIndex(0, 2, true, true)).toBe(2); // A after C: B C A D
    expect(getTabDropIndex(0, 2, false, true)).toBe(1); // A before C: B A C D
    expect(getTabDropIndex(0, 3, true, true)).toBe(3); // A after D: B C D A
    expect(getTabDropIndex(1, 2, false, true)).toBe(1); // B before C: no change
  });

  test('a tab moving left within its group is not corrected', () => {
    expect(getTabDropIndex(3, 0, false, true)).toBe(0); // D before A
    expect(getTabDropIndex(3, 0, true, true)).toBe(1); // D after A
    expect(getTabDropIndex(2, 1, true, true)).toBe(2); // C after B: no change
  });

  test('either half of the dragged tab itself leaves it where it is', () => {
    expect(getTabDropIndex(1, 1, false, true)).toBe(1);
    expect(getTabDropIndex(1, 1, true, true)).toBe(1);
  });

  test('a tab from another group is never corrected', () => {
    expect(getTabDropIndex(0, 2, true, false)).toBe(3);
    expect(getTabDropIndex(0, 2, false, false)).toBe(2);
    expect(getTabDropIndex(5, 0, false, false)).toBe(0);
    // Over the empty strip of an empty group: the first slot.
    expect(getTabDropIndex(0, -1, true, false)).toBe(0);
  });
});

test('isAfterTabMiddle splits a tab at its middle, the middle itself on the left', () => {
  expect(isAfterTabMiddle(150, 100, 100)).toBe(false);
  expect(isAfterTabMiddle(150.5, 100, 100)).toBe(true);
  expect(isAfterTabMiddle(100, 100, 100)).toBe(false);
  expect(isAfterTabMiddle(199, 100, 100)).toBe(true);
});
