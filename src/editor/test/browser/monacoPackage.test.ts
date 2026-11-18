// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const monacoRoot = join(projectRoot, 'node_modules/monaco-editor');

function sources(folder: string): string[] {
  return readdirSync(join(projectRoot, folder), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.[cm]?tsx?$/.test(entry.name))
    .map(entry => relative(projectRoot, join(entry.parentPath, entry.name)));
}

test('only the adapter imports monaco-editor, so the package stays behind loadMonaco', () => {
  const importing = [...sources('src'), ...sources('test')]
    .filter(file => /\b(?:from|import)\s*\(?\s*['"]monaco-editor(?:\/[^'"]*)?['"]/.test(readFileSync(join(projectRoot, file), 'utf8')))
    .sort();
  expect(importing).toEqual(['src/editor/browser/monaco.ts']);
});

test('the notices shipped in dist carry Monaco\'s own notices and the DOMPurify it bundles', () => {
  const notices = readFileSync(join(projectRoot, 'ThirdPartyNotices.txt'), 'utf8');
  const monacoNotices = readFileSync(join(monacoRoot, 'ThirdPartyNotices.txt'), 'utf8').trimEnd();
  expect(notices).toContain(monacoNotices);

  const bundledPurify = readFileSync(join(monacoRoot, 'esm/vs/base/browser/dompurify/dompurify.js'), 'utf8');
  const version = /@license DOMPurify (\S+)/.exec(bundledPurify)?.[1];
  expect(notices).toContain(`DOMPurify ${version} (bundled in monaco-editor)`);
  expect(notices).toContain(readFileSync(join(projectRoot, 'node_modules/dompurify/LICENSE'), 'utf8').trimEnd());
  // A path into node_modules means nothing next to dist/.
  expect(notices).not.toMatch(/notices: node_modules\//i);
});
