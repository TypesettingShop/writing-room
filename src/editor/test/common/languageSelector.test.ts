// @vitest-environment node
import { expect, test } from 'vitest';
import { URI } from '../../../base/common/uri.js';
import { score } from '../../common/languageSelector.js';
import type { LanguageSelector } from '../../common/languageSelector.js';

const markdown = URI.parse('vscode-vfs://writing-room/workspace/docs/a.md');
const untitled = URI.parse('untitled:Untitled-1');

// VS Code's scores (`src/vs/editor/common/languageSelector.ts`), cell by cell.
const table: [selector: LanguageSelector, uri: URI, language: string, expected: number][] = [
  ['markdown', markdown, 'markdown', 10],
  ['markdown', markdown, 'plaintext', 0],
  ['*', markdown, 'plaintext', 5],
  [{ language: 'markdown' }, markdown, 'markdown', 10],
  [{ language: 'markdown' }, untitled, 'plaintext', 0],
  [{ language: '*' }, untitled, 'plaintext', 5],
  [{ scheme: 'untitled' }, untitled, 'plaintext', 10],
  [{ scheme: 'untitled' }, markdown, 'markdown', 0],
  [{ scheme: 'vscode-vfs' }, markdown, 'markdown', 10],
  [{ scheme: '*' }, markdown, 'markdown', 5],
  [{ scheme: '*', language: 'markdown' }, markdown, 'markdown', 10],
  [{ scheme: 'untitled', language: '*' }, untitled, 'plaintext', 10],
  [{ scheme: '*', language: '*' }, untitled, 'plaintext', 5],
  [{ scheme: 'untitled', language: 'markdown' }, untitled, 'plaintext', 0],
  [{ pattern: '**/*.md' }, markdown, 'markdown', 10],
  [{ pattern: '**/*.txt' }, markdown, 'markdown', 0],
  [{ pattern: '/workspace/docs/a.md' }, markdown, 'markdown', 10],
  [{ language: 'markdown', pattern: '**/*.md' }, markdown, 'markdown', 10],
  [{ language: '*', pattern: '**/*.txt' }, markdown, 'markdown', 0],
  [{ pattern: { base: '/workspace/docs', pattern: '*.md' } }, markdown, 'markdown', 10],
  [{ pattern: { base: '/workspace/other', pattern: '*.md' } }, markdown, 'markdown', 0],
  [{ notebookType: 'jupyter-notebook' }, markdown, 'markdown', 0],
  [{ language: 'markdown', notebookType: '*' }, markdown, 'markdown', 0],
  [{}, markdown, 'markdown', 0],
  [['plaintext', { language: '*' }], markdown, 'markdown', 5],
  [['plaintext', { scheme: 'vscode-vfs' }, '*'], markdown, 'markdown', 10],
  [[{ language: 'plaintext' }, { scheme: 'untitled' }], markdown, 'markdown', 0],
  [[], markdown, 'markdown', 0],
];

test.each(table)('scores %j on %s (%s) as VS Code does', (selector, uri, language, expected) => {
  expect(score(selector, uri, language, true)).toBe(expected);
});

test('a document that is not synchronized scores 0 for every selector', () => {
  for (const [selector, uri, language] of table) {
    expect(score(selector, uri, language, false)).toBe(0);
  }
});

test('a pattern the matcher refuses matches nothing rather than throwing', () => {
  expect(score({ pattern: 'x'.repeat(5000) }, markdown, 'markdown', true)).toBe(0);
});
