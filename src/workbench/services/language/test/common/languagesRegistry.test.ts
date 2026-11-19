// @vitest-environment node
import { expect, test } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { LanguagesRegistry, PLAINTEXT_DEFINITION } from '../../common/languagesRegistry.js';
import type { ILanguageDefinition } from '../../common/languagesRegistry.js';

const builtin: ILanguageDefinition[] = [
  PLAINTEXT_DEFINITION,
  { id: 'markdown', aliases: ['Markdown', 'markdown'], extensions: ['.md', '.markdown'] },
  { id: 'dockerfile', aliases: ['Dockerfile'], extensions: ['.dockerfile'], filenames: ['Dockerfile'] },
  { id: 'shell', aliases: ['Shell Script'], extensions: ['.sh'], firstLine: '^#!.*\\b(bash|sh)\\b' },
];

const guess = (registry: LanguagesRegistry, path: string, firstLine?: string) => registry.guessLanguageId(path, firstLine);

test('an exact file name wins over an extension, ignoring case', () => {
  const registry = new LanguagesRegistry([...builtin, { id: 'notes', extensions: ['.dockerfile'] }]);
  expect(guess(registry, '/project/dockerfile')).toBe('dockerfile');
  expect(guess(registry, '/project/DOCKERFILE')).toBe('dockerfile');
  // By extension alone the definition registered last wins.
  expect(guess(registry, '/project/build.dockerfile')).toBe('notes');
});

test('the longest extension wins, whatever the order of registration', () => {
  const longFirst = new LanguagesRegistry([{ id: 'fixturelang', extensions: ['.fixture.md'] }, ...builtin]);
  const longLast = new LanguagesRegistry([...builtin, { id: 'fixturelang', extensions: ['.fixture.md'] }]);
  for (const registry of [longFirst, longLast]) {
    expect(guess(registry, '/a/notes.fixture.md')).toBe('fixturelang');
    expect(guess(registry, '/a/notes.md')).toBe('markdown');
    expect(guess(registry, '/a/NOTES.MD')).toBe('markdown');
  }
});

test('a file name pattern wins over an extension, and a pattern with a slash matches the path', () => {
  const registry = new LanguagesRegistry([
    ...builtin,
    { id: 'readme', filenamePatterns: ['readme*.md'] },
    { id: 'docs', filenamePatterns: ['**/docs/*.md'] },
  ]);
  expect(guess(registry, '/a/README.en.md')).toBe('readme');
  expect(guess(registry, '/a/docs/guide.md')).toBe('docs');
  expect(guess(registry, '/a/other/guide.md')).toBe('markdown');
});

test('the first line counts only when the path names no language, and a BOM is skipped', () => {
  const registry = new LanguagesRegistry(builtin);
  expect(guess(registry, '/bin/run', '#!/usr/bin/env bash')).toBe('shell');
  expect(guess(registry, '/bin/run', '﻿#!/bin/sh')).toBe('shell');
  expect(guess(registry, '/bin/run.md', '#!/usr/bin/env bash')).toBe('markdown');
  expect(guess(registry, '/bin/run', 'echo')).toBeNull();
  expect(guess(registry, '', '#!/bin/sh')).toBeNull();
  expect(guess(registry, 'Untitled-1')).toBeNull();
});

test('a definition registered twice merges, and names come from the first alias', () => {
  const registry = new LanguagesRegistry([...builtin, { id: 'markdown', aliases: ['Markdown'], extensions: ['.mkd', '.md'] }]);
  expect(registry.getExtensions('markdown')).toEqual(['.md', '.markdown', '.mkd']);
  expect(registry.getLanguageName('markdown')).toBe('Markdown');
  expect(registry.getLanguageName('plaintext')).toBe('Plain Text');
  expect(registry.getLanguageIdByLanguageName('MARKDOWN')).toBe('markdown');
  expect(registry.getLanguageIdByLanguageName('shell')).toBe('shell');
  expect(registry.getLanguageIdByLanguageName('nothing')).toBeNull();
  expect(registry.getSortedRegisteredLanguageNames().map(pair => pair.languageName))
    .toEqual(['Dockerfile', 'Markdown', 'Plain Text', 'Shell Script']);
  expect(registry.getLanguageName('unknown')).toBeNull();
});

test('a first line that is not a regular expression is reported and the rest of the definition stays', () => {
  const messages: string[] = [];
  const registry = new LanguagesRegistry([{ id: 'broken', extensions: ['.brk'], firstLine: '(' }], message => messages.push(message));
  expect(messages).toEqual([expect.stringContaining("'(' of 'broken'")]);
  expect(guess(registry, '/a/b.brk')).toBe('broken');
  expect(guess(registry, '/a/b', '(')).toBeNull();
});

test('keeps the configuration files of a language in registration order', () => {
  const first = URI.parse('http://127.0.0.1/a/language-configuration.json');
  const second = URI.parse('http://127.0.0.1/b/language-configuration.json');
  const registry = new LanguagesRegistry([{ id: 'x', configuration: first }, { id: 'x', configuration: second }]);
  expect(registry.getConfigurationFiles('x')).toEqual([first, second]);
  expect(registry.getConfigurationFiles('y')).toEqual([]);
});
