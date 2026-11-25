import { expect, test } from 'vitest';
import { renderIcon, renderLabelWithIcons } from '../../browser/ui/iconLabel/iconLabels.js';
import { ThemeIcon } from '../../common/themables.js';

test('parses an icon id and generates modifier classes', () => {
  const icon = ThemeIcon.fromString('$(loading~spin)');
  expect(icon).toEqual({ id: 'loading~spin' });
  expect(ThemeIcon.asClassName(icon!)).toBe('codicon codicon-loading codicon-modifier-spin');
  expect(ThemeIcon.fromString('prefix $(loading)')).toBeUndefined();
});

test('keeps adjacent text and escaped tokens while omitting unknown glyphs', () => {
  const parts = renderLabelWithIcons('Open $(edit) & \\$(close) $(no-such-icon) now');
  expect(parts.filter(part => typeof part === 'string').join('')).toBe('Open  & $(close)  now');
  const icons = parts.filter(part => typeof part !== 'string');
  expect(icons).toHaveLength(1);
  expect(icons[0]).toBeInstanceOf(HTMLSpanElement);
  expect(icons[0].className).toBe('codicon codicon-edit');
  expect(icons[0].getAttribute('aria-hidden')).toBe('true');
  expect(renderIcon({ id: 'no-such-icon' })).toBeUndefined();
});

test('recognizes font aliases and consecutive icons', () => {
  expect(renderLabelWithIcons('$(plus)$(loading~spin)').map(part => typeof part === 'string' ? part : part.className))
    .toEqual(['codicon codicon-plus', 'codicon codicon-loading codicon-modifier-spin']);
});

test.each([
  'world', 'world-category', 'world-category-add', 'world-item', 'world-item-add', 'world-calendar',
  'character-male', 'character-female', 'character-unknown', 'character-animal',
  'characters-group', 'characters-group-add', 'character-add',
])('renders %s as an accessible-name-neutral icon', id => {
  const icon = renderIcon({ id });
  expect(icon?.className).toBe('codicon codicon-' + id);
  expect(icon?.getAttribute('aria-hidden')).toBe('true');
});
