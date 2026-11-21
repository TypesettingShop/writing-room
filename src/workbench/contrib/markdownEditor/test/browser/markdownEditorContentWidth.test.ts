import { expect, test } from 'vitest';
import { isMarkdownContentWidth } from '../../common/markdownEditor.js';

test('accepts whole content widths within the setting bounds', () => {
  for (const value of [20, 60, 80, 400]) {
    expect(isMarkdownContentWidth(value)).toBe(true);
  }
  for (const value of [undefined, null, 0, -20, 19, 401, 60.5, '60', NaN, Infinity]) {
    expect(isMarkdownContentWidth(value)).toBe(false);
  }
});
