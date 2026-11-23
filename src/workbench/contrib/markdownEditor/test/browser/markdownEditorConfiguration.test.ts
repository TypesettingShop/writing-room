import { expect, test } from 'vitest';
import { configurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import '../../browser/markdownEditor.contribution.js';

test.each([
  'markdownEditor.typewriterScroll',
  'markdownEditor.fontSize',
  'markdownEditor.fontFamily',
])('%s describes the Manuscript Editor', key => {
  const setting = configurationRegistry.getConfigurationProperties().get(key);
  expect(setting?.description).toContain('Manuscript Editor');
});
