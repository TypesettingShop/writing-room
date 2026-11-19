import { expect, test, vi } from 'vitest';
import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

class TestInput extends EditorInput {
  constructor(readonly resource = URI.parse('test:one')) { super(); }
  override get typeId(): string { return 'test.input'; }
}

test('matches only itself unless an input says otherwise', () => {
  const input = new TestInput();
  expect(input.matches(input)).toBe(true);
  expect(input.matches(new TestInput())).toBe(false);
  expect(input.getName()).toBe('Editor test.input');
  expect(input.isDirty()).toBe(false);
});

test('fires onWillDispose once and reads as disposed from then on', () => {
  const input = new TestInput();
  const seen: boolean[] = [];
  const onWillDispose = vi.fn(() => seen.push(input.isDisposed()));
  input.onWillDispose(onWillDispose);
  input.dispose();
  input.dispose();
  expect(onWillDispose).toHaveBeenCalledTimes(1);
  expect(seen).toEqual([true]);
  expect(input.isDisposed()).toBe(true);
});

test('parses and prints the resources editors use', () => {
  const uri = URI.parse('untitled:Untitled-3');
  expect([uri.scheme, uri.path, uri.toString()]).toEqual(['untitled', 'Untitled-3', 'untitled:Untitled-3']);
  expect(URI.parse('https://example.com/a/b?c=1#d').toString()).toBe('https://example.com/a/b?c=1#d');
  expect(() => URI.parse('no-scheme')).toThrow('Invalid URI');
  // Components that would print as a different URI are refused rather than misprinted.
  expect(() => URI.from({ scheme: 'untitled', path: 'a#b' })).toThrow('Invalid URI');
  expect(() => URI.from({ scheme: 'file', authority: 'host', path: 'relative' })).toThrow('Invalid URI');
  expect(() => URI.from({ scheme: 'file', path: '//host/path' })).toThrow('Invalid URI');
});
