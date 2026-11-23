import { expect, test } from 'vitest';
import { configurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import '../../browser/markdownEditor.contribution.js';
import '../../browser/markdownEditorPresentation.contribution.js';

test.each([
  'markdownEditor.typewriterScroll',
  'markdownEditor.fontSize',
  'markdownEditor.fontFamily',
  'markdownEditor.sectionNumbers',
  'markdownEditor.footnotes.panel',
])('%s describes the Manuscript Editor', key => {
  const setting = configurationRegistry.getConfigurationProperties().get(key);
  expect(setting?.description).toContain('Manuscript Editor');
});

test('no Manuscript Editor setting describes the old Markdown editor name', () => {
  const descriptions = [...configurationRegistry.getConfigurationProperties()]
    .filter(([key]) => key.startsWith('markdownEditor.'))
    .map(([key, { description }]) => `${key}: ${description}`);
  expect(descriptions.length).toBeGreaterThan(0);
  expect(descriptions.filter(text => /markdown editor/i.test(text))).toEqual([]);
});
