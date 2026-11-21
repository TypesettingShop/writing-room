import { expect, test } from 'vitest';
import { scan } from '../../common/scanner.js';

const kinds = (text: string) => scan(text).map(token => [token.kind, token.text]);

test.each([
  [String.raw`a =~ /x\/y/i`, [['word', 'a'], ['=~', '=~'], ['regex', String.raw`/x\/y/i`], ['end', '']]],
  ['a =~ /[/]/ && b', [['word', 'a'], ['=~', '=~'], ['regex', '/[/]/'], ['&&', '&&'], ['word', 'b'], ['end', '']]],
  ['a =~ /x/gq', [['word', 'a'], ['=~', '=~'], ['regex', '/x/g'], ['word', 'q'], ['end', '']]],
  ['a not in b', [['word', 'a'], ['not', 'not'], ['in', 'in'], ['word', 'b'], ['end', '']]],
  // As in VS Code, `<` and `>` belong to a word they follow, so a comparison needs a space before it.
  ['n<=1', [['word', 'n<'], ['error', '='], ['word', '1'], ['end', '']]],
  ['n <=1 || n >=-2', [['word', 'n'], ['<=', '<='], ['word', '1'], ['||', '||'], ['word', 'n'], ['>=', '>='], ['word', '-2'], ['end', '']]],
  ['a === b !== c', [['word', 'a'], ['==', '==='], ['word', 'b'], ['!=', '!=='], ['word', 'c'], ['end', '']]],
  ["k == 'two words'", [['word', 'k'], ['==', '=='], ['string', 'two words'], ['end', '']]],
  ['fee.bee<K-loo+1> > 2', [['word', 'fee.bee<K-loo+1>'], ['>', '>'], ['word', '2'], ['end', '']]],
  ['index < 2', [['word', 'index'], ['<', '<'], ['word', '2'], ['end', '']]],
])('scans %s', (text, expected) => {
  expect(kinds(text)).toEqual(expected);
});

test.each([
  ["a == 'oops", "'oops", /close the quote/],
  ['a =~ /x', '/x', /escape the '\/'/],
  ['a = b', '=', /== or =~/],
  ['a & b', '&', /&&/],
  ['a | b', '|', /\|\|/],
  ['a {', '{', /not part of a when clause/],
])('%s gives an error token instead of throwing', (text, lexeme, message) => {
  const error = scan(text).find(token => token.kind === 'error');
  expect(error?.text).toBe(lexeme);
  expect(error?.message).toMatch(message);
});
