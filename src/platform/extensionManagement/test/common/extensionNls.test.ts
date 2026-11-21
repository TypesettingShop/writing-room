import { expect, test } from 'vitest';
import { localizeManifest } from '../../common/extensionNls.js';

test('localizes display fields without rewriting identifiers, settings keys or the original manifest', () => {
  const original = {
    publisher: 'test', name: 'localization', version: '1.0.0', displayName: '%display%',
    contributes: {
      commands: [{ command: '%command%', title: '%display%', category: '%missing%' }],
      configuration: { properties: { '%setting%': { description: '%display%', default: '%display%' } } },
    },
  };
  expect(localizeManifest(original, {
    command: 'rewritten command', display: { message: 'Translated', comment: ['display text'] },
    setting: 'rewritten setting',
  })).toEqual({
    ...original,
    displayName: 'Translated',
    contributes: {
      commands: [{ command: '%command%', title: 'Translated', category: '%missing%' }],
      configuration: { properties: { '%setting%': { description: 'Translated', default: '%display%' } } },
    },
  });
  expect(original.contributes.commands[0].title).toBe('%display%');
});
