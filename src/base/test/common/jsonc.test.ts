import { expect, test } from 'vitest';
import { parseJSONC, setJSONCProperty } from '../../common/jsonc.js';

test('reads JSON with both comment forms, trailing commas and string punctuation', () => {
  const text = '\ufeff{\r\n\t// heading\r\n\t"url": "https://host/path/*x*/", /* another */\r\n'
    + '\t"escaped": "a\\\"//b", "data": [1, {"brace": "}",},],\r\n}\r\n';
  expect(parseJSONC(text)).toEqual({ url: 'https://host/path/*x*/', escaped: 'a"//b', data: [1, { brace: '}' }] });
});

test.each(['{,}', '[,]', '{"x":,}', '{"x":1,,}', '{"x":tr/* comment */ue}', '{} /* unterminated', '{"x":"broken}'])(
  'rejects malformed JSONC %s', text => expect(parseJSONC(text)).toBeUndefined(),
);

test('edits only the last top-level occurrence and retains comments and whitespace', () => {
  const text = '{\r\n  "editor.fontSize": 12,\r\n  "other": {"editor.fontSize": 18},\r\n'
    + '  "editor.fontSize" : /* style */ [1,2] , // keep\r\n}\r\n';
  const result = setJSONCProperty(text, 'editor.fontSize', 24);
  expect(result).toBe(text.replace('[1,2]', '24'));
  expect(parseJSONC(result)).toMatchObject({ 'editor.fontSize': 24, other: { 'editor.fontSize': 18 } });
});

test.each([
  ['{\n\t"x": 1 // keep\n}\n', '{\n\t"x": 1, // keep\n\t"y": true\n}\n'],
  ['{\r\n\t"x": 1, /* keep */\r\n}\r\n', '{\r\n\t"x": 1, /* keep */\r\n\t"y": true,\r\n}\r\n'],
  ['{"x":1}', '{"x":1, "y": true}'],
  ['{\n  // empty\n}', '{\n  // empty\n  "y": true\n}'],
  ['{}', '{"y": true}'],
])('adds one property while retaining the original source', (text, expected) => {
  const result = setJSONCProperty(text, 'y', true);
  expect(result).toBe(expected);
  expect(parseJSONC(result)).toMatchObject({ y: true });
});

test.each([
  // Inside an existing language section, keeping its comments, trailing commas and other keys.
  ['{\n  "x": 1,\n  "[markdown]": {\n    // keep\n    "y": false,\n    "z": 2,\n  },\n}\n',
    '{\n  "x": 1,\n  "[markdown]": {\n    // keep\n    "y": true,\n    "z": 2,\n  },\n}\n'],
  ['{\n  "[markdown]": {\n    "z": 2 // keep\n  }\n}\n', '{\n  "[markdown]": {\n    "z": 2, // keep\n    "y": true\n  }\n}\n'],
  ['{\n  "[markdown]": {}\n}\n', '{\n  "[markdown]": {"y": true}\n}\n'],
  // A new section, at the end of the object; the top-level "y" stays as it is.
  ['{\n\t"y": false, // top\n}\n', '{\n\t"y": false, // top\n\t"[markdown]": {\n\t\t"y": true\n\t},\n}\n'],
  // A section that is not an object becomes one.
  ['{ "[markdown]": 1 }', '{ "[markdown]": {"y":true} }'],
])('sets a key inside a language section %#', (text, expected) => {
  expect(setJSONCProperty(text, ['[markdown]', 'y'], true)).toBe(expected);
});

test('writes object and array values in the layout of the surrounding text', () => {
  expect(setJSONCProperty('{\n    "a": 1\n}\n', 'b', { x: [1, 2] }))
    .toBe('{\n    "a": 1,\n    "b": {\n        "x": [\n            1,\n            2\n        ]\n    }\n}\n');
  expect(setJSONCProperty('{"a": 1}', 'a', { x: 1 })).toBe('{"a": {"x":1}}');
});

test.each([
  ['{\n  // a\n  "a": 1,\n  "b": 2,\n}\n', 'b', '{\n  // a\n  "a": 1,\n}\n'],
  ['{\n  "a": 1, // a\n  // b\n  "b": 2\n}\n', 'b', '{\n  "a": 1 // a\n  // b\n}\n'],
  ['{"a": 1, "b": 2}', 'b', '{"a": 1 }'],
  ['{\n  "b": 2, // b\n  "a": 1\n}\n', 'b', '{\n  "b": 2, // b\n  "a": 1\n}\n'.replace('  "b": 2, // b\n', '  // b\n')],
  ['{\n  "b": 1,\n  "a": 1,\n  "b": 2\n}\n', 'b', '{\n  "a": 1\n}\n'],
  ['{"b": 1}', 'b', '{}'],
  ['{"a": 1}', 'b', '{"a": 1}'],
])('removes every occurrence of a key and nothing else %#', (text, key, expected) => {
  expect(setJSONCProperty(text, key, undefined)).toBe(expected);
});

test('removes a key inside a language section and leaves the section', () => {
  const text = '{\n  "y": 1,\n  "[markdown]": {\n    "y": 2,\n    "z": 3\n  }\n}\n';
  expect(setJSONCProperty(text, ['[markdown]', 'y'], undefined)).toBe('{\n  "y": 1,\n  "[markdown]": {\n    "z": 3\n  }\n}\n');
  expect(setJSONCProperty(text, ['[json]', 'y'], undefined)).toBe(text);
});
