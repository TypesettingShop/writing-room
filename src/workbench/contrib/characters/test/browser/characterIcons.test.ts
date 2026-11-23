import { expect, test } from 'vitest';
import { renderIcon, renderLabelWithIcons } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { characterTypes } from '../../../../../platform/characters/common/characters.js';
import { characterTypeIcon } from '../../browser/characterIcons.js';

test('maps the four types to distinct registered ThemeIcons with accessible descriptions', () => {
  const icons = characterTypes.map(characterTypeIcon);
  expect(icons.map(icon => icon.label)).toEqual(['Male', 'Female', 'Unknown', 'Animal']);
  expect(new Set(icons.map(icon => icon.id)).size).toBe(4);
  for (const icon of icons) {
    const element = renderIcon(icon);
    expect(element?.className).toBe(`codicon codicon-${icon.id}`);
    expect(element?.getAttribute('aria-hidden')).toBe('true');
  }
});

test('falls back to Unknown for missing and unexpected types', () => {
  const unknown = characterTypeIcon('unknown');
  for (const type of [undefined, null, 'robot', 'toString', '__proto__']) {
    expect(characterTypeIcon(type)).toEqual(unknown);
  }
});

test('renders a character icon in the same label as a regular codicon', () => {
  const { id } = characterTypeIcon('male');
  expect(renderLabelWithIcons(`$(${id}) Character $(loading~spin)`).map(part =>
    typeof part === 'string' ? part : part.className,
  )).toEqual([`codicon codicon-${id}`, ' Character ', 'codicon codicon-loading codicon-modifier-spin']);
});
