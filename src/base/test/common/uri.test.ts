import { describe, expect, test } from 'vitest';
import { match, parse } from '../../common/glob.js';
import { basename, dirname, extname, isEqual, isEqualOrParent, normalizePath, relativePath } from '../../common/resources.js';
import { URI } from '../../common/uri.js';

describe('URI', () => {
  test.each([
    ['untitled:Untitled-1', 'untitled:Untitled-1'],
    ['vscode-userdata:/User/settings.json', 'vscode-userdata:/User/settings.json'],
    ['https://EXAMPLE.TEST:443/a b?key=한/글#x/y', 'https://example.test:443/a%20b?key%3D%ED%95%9C%2F%EA%B8%80#x%2Fy'],
    ['file:///a%20%ED%95%9C%23%3F%25!.md', 'file:///a%20%ED%95%9C%23%3F%25%21.md'],
    ['https://[::1]/C:path', 'https://[::1]/C%3Apath'],
    ['test:😀%FF%20', 'test:%F0%9F%98%80%25FF%20'],
  ])('formats %s with canonical URI escaping', (source, formatted) => {
    expect(URI.parse(source).toString()).toBe(formatted);
  });

  test('escapes only component delimiters for toString(true) and keeps the cached full form', () => {
    const uri = URI.parse('https://EXAMPLE.TEST/a%20b/%E2%9C%93?key=a%20b&x=1#f%20g');
    const encoded = 'https://example.test/a%20b/%E2%9C%93?key%3Da%20b%26x%3D1#f%20g';
    expect(uri.toString()).toBe(encoded);
    expect(uri.toString(true)).toBe('https://example.test/a b/✓?key=a b&x=1#f g');
    expect(uri.toString()).toBe(encoded);
    expect(URI.file('/C:/a#b?c.md').toString(true)).toBe('file:///c:/a%23b%3Fc.md');
  });

  test('round-trips decoded components through strings and structured cloning', () => {
    const file = URI.file('/a 한#?%😀.md');
    expect(URI.parse(file.toString()).fsPath).toBe(file.fsPath);
    const wire = structuredClone(file.toJSON());
    expect(wire.$mid).toBe(1);
    expect(URI.isUri(wire)).toBe(false);
    expect(URI.revive(wire)).toEqual(file);
    expect(URI.revive(URI.parse('vscode-vfs://writing-room/workspace/a%2Fb').toJSON()).hasEncodedPathSeparator).toBe(true);
    expect(URI.parse('relative').fsPath).toBe('/relative');
    expect(relativePath(URI.parse('test:.'), URI.parse('test:child'))).toBe('child');
  });

  test('keeps the original command query and the empty HTTP query marker through revival', () => {
    const command = URI.parse('command:test.run?["a%22b"]');
    expect(URI.revive(command.toJSON()).rawQuery).toBe('["a%22b"]');
    const url = URI.revive(URI.parse('http://example.test/path?').toJSON());
    expect(url.toHttpURL().href).toBe('http://example.test/path?');
    expect(url.with({ query: null }).toHttpURL().href).toBe('http://example.test/path');
  });

  test('distinguishes encoded separators and retains their provenance in derived paths', () => {
    const ambiguous = URI.parse('vscode-vfs://writing-room/workspace/a%2Fb');
    const canonical = URI.parse('vscode-vfs://writing-room/workspace/a/b');
    expect(isEqual(ambiguous, canonical)).toBe(false);
    expect(isEqualOrParent(ambiguous, URI.joinPath(canonical, '..'))).toBe(false);
    expect(URI.joinPath(ambiguous, 'child').hasEncodedPathSeparator).toBe(true);
    expect(normalizePath(ambiguous.with({ query: 'test' })).hasEncodedPathSeparator).toBe(true);
    expect(ambiguous.with({ path: '/workspace/c' }).hasEncodedPathSeparator).toBe(false);
  });

  test('joins at the root and compares complete path segments', () => {
    const parent = URI.parse('vscode-vfs://writing-room/a/b');
    const file = URI.joinPath(parent, './c/../x.md');
    expect(URI.joinPath(parent, '../../../../x').path).toBe('/x');
    expect(normalizePath(parent.with({ path: '/a//b/../b/' })).path).toBe(parent.path);
    expect(dirname(file)).toEqual(parent);
    expect([basename(file), extname(file), relativePath(parent, file)]).toEqual(['x.md', '.md', 'x.md']);
    expect(isEqualOrParent(file, parent)).toBe(true);
    expect(isEqualOrParent(parent.with({ path: '/a/bc' }), parent)).toBe(false);
    expect(isEqualOrParent(file.with({ authority: 'other' }), parent)).toBe(false);
  });
});

describe('glob', () => {
  test('matches globstars, dot files, brace alternatives, and classes', () => {
    const markdown = parse('**/*.md');
    expect(['a.md', '.draft.md', 'nested/.hidden/a.md', 'a.MD'].map(markdown)).toEqual([true, true, true, false]);
    expect(match('*.{jpg,png}', 'a.png')).toBe(true);
    expect(match('**/.markdownlint.{jsonc,json,yaml,yml,cjs,mjs}', 'deep/.markdownlint.yaml')).toBe(true);
    expect(match('a[0-9][!x]?.md', 'a2yz.md')).toBe(true);
    expect(match('a[0-9][!x]?.md', 'a2xz.md')).toBe(false);
    expect(match('{src/{a,b},test}/**/*.ts', 'src/b/file.ts')).toBe(true);
  });

  test('anchors relative globs and normalizes single-dot segments in patterns', () => {
    expect(match('*.md', '/x.md')).toBe(false);
    expect(match('a/*.md', '/a/x.md')).toBe(false);
    expect(match('**/*.md', '/a/x.md')).toBe(true);
    expect(match('/a/*.md', 'a/x.md')).toBe(false);
    expect(match('./a/./*.md', 'a/x.md')).toBe(true);
  });

  test('matches relative to a folder and bounds pattern size and brace expansion', () => {
    const markdown = parse({ base: '/workspace/project/', pattern: '**/*.md' });
    expect(markdown('/workspace/project/src/a.md')).toBe(true);
    expect(markdown('/workspace/projects/a.md')).toBe(false);
    expect(markdown('/workspace/project/../a.md')).toBe(false);
    expect(() => parse('한'.repeat(1366))).toThrow(RangeError);
    expect(() => parse('{a,b}'.repeat(7))).toThrow(RangeError);
    const alternatives = Array.from({ length: 99 }, (_, index) => index).join(',');
    expect(match(`{extra,{${alternatives}}}`, '98')).toBe(true);
    expect(match('*a'.repeat(1000) + 'b', 'a'.repeat(1000))).toBe(false);
  });
});
