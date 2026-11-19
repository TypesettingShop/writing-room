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
