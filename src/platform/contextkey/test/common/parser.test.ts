import { expect, test } from 'vitest';
import { ContextKeyExpr, Parser } from '../../common/contextkey.js';
import type { ContextKeyExpression, IContext } from '../../common/contextkey.js';

const values: Record<string, unknown> = {
  n: 10, neg: -1, numeric: '5', word: 'abc', flag: true,
  text: 'Hello World', path: 'src/x.ts',
  item: 'a', other: 'z', list: ['a', 'b'], map: { a: 1 },
};
const context: IContext = { getValue: <T>(key: string) => values[key] as T | undefined };

function parse(text: string): ContextKeyExpression {
  const parser = new Parser();
  const expression = parser.parse(text);
  expect(parser.parsingErrors, text).toEqual([]);
  return expression!;
}

test.each([
  // Size comparisons read the value as a number; a missing or non-numeric value, or bound, never matches.
  ['n > 1', true], ['n > 10', false], ['missing > 1', false],
  ['n >= 10', true], ['n >= 11', false], ['missing >= 1', false],
  ['n < 11', true], ['n < 10', false], ['missing < 1', false],
  ['n <= 10', true], ['n <= 9', false], ['missing <= 1', false],
  ['neg >= -1', true], ['numeric < 6', true], ['word > 1', false], ['word < 1', false],
  ['n > abc', false], ['n <= abc', false], ["n > 'a b'", false], ['n >', false],
  // Negation flips the comparison, so a missing key stays false both ways.
  ['!(n > 20)', true], ['!(n > 1)', false], ['!(missing > 1)', false], ['!(n > abc)', false],

  // `in` looks the value of the left key up in the array or object the right key holds.
  ['item in list', true], ['other in list', false], ['missing in list', false], ['item in missing', false],
  ['item in map', true], ['other in map', false], ["item in 'list'", true], ['n in map', false],
  ['item not in list', false], ['other not in list', true], ['missing not in list', true], ['item not in missing', true],
  ['!(item in list)', false], ['!(item not in list)', true],

  // `=~` matches the value as text.
  ['text =~ /hello/i', true], ['text =~ /hello/', false], ['missing =~ /x/', false],
  ['flag =~ /^true$/', true], ['n =~ /^10$/', true],
  [String.raw`path =~ /src\/x/`, true], ['path =~ /[/]x/', true], [String.raw`path =~ /src\/y/`, false],
  ['text =~ /world/gi', true], ['!(text =~ /hello/i)', false], ['!(text =~ /bye/)', true],
  ['text =~ /o W/ && item in list && n > 1', true],
  ['n > 1 && (missing in list || text =~ /world$/i)', true],
])('%s evaluates to %s, also after a serialize round trip', (text, expected) => {
  const expression = parse(text);
  expect(expression.evaluate(context)).toBe(expected);
  // A global regex would remember where it stopped; the same value has to match on every evaluation.
  expect(expression.evaluate(context)).toBe(expected);

  const again = parse(expression.serialize());
  expect(again.serialize()).toBe(expression.serialize());
  expect(again.evaluate(context)).toBe(expected);
  expect(again.negate().evaluate(context)).toBe(expression.negate().evaluate(context));
});

test.each([
  ['n >1', 'n > 1'],
  ['foo.bar >= -1', 'foo.bar >= -1'],
  ['n < 2.50', 'n < 2.5'],
  ['n > abc', "n > 'abc'"],
  ["n > 'a b'", "n > 'a b'"],
  ['!(n > 1)', 'n <= 1'],
  ['!(n < 1)', 'n >= 1'],
  ['a in b', "a in 'b'"],
  ["a in 'b c'", "a in 'b c'"],
  ['a not in b', "a not in 'b'"],
  ['!(a in b)', "a not in 'b'"],
  ['!(a not in b)', "a in 'b'"],
  [String.raw`a =~ /x\/y/i`, String.raw`a =~ /x\/y/i`],
  ['a =~ /x/gimsuy', 'a =~ /x/imsu'],
  ['!(a =~ /x/)', '!(a =~ /x/)'],
  ['a === b', "a == 'b'"],
  ['a !== b', "a != 'b'"],
  ["k == 'two words'", "k == 'two words'"],
])('%s serializes as %s', (text, serialized) => {
  expect(parse(text).serialize()).toBe(serialized);
  expect(parse(serialized).serialize()).toBe(serialized);
});

test('a slash inside a character class or escaped does not end the regex', () => {
  for (const [text, source] of [[String.raw`a =~ /x\/y/i`, String.raw`x\/y`], ['a =~ /[/]/', '[/]'], ['a =~ /[\\]/]/', String.raw`[\]/]`]]) {
    const parsed = parse(text);
    expect(parsed.serialize()).toMatch(new RegExp(`/${source.replace(/[\\[\]/]/g, '\\$&')}/`));
    expect(parsed.evaluate({ getValue: <T>() => 'x/y' as T })).toBe(true);
  }
});

test.each([
  ['a =~ /(/', /Invalid regular expression/],
  ['a =~ /x/ii', /Invalid regular expression/],
  ['a =~ /[/', /escape the '\/'|Invalid regular expression/],
  ['a =~ /x', /escape the '\/'/],
  ['a =~ x', /Expected a regular expression/],
  ['a =~', /Expected a regular expression/],
  ['a =~ /x/ b', /Invalid regular expression|Expected end/],
  ['b && a =~ /x)/ || c', /Invalid regular expression/],
])('%s is a syntax error with a message', (text, message) => {
  for (const parser of [new Parser(), new Parser({ regexParsingWithErrorRecovery: false })]) {
    expect(() => parser.parse(text)).not.toThrow();
    expect(parser.parse(text)).toBeUndefined();
    expect(parser.parsingErrors).toHaveLength(1);
    expect(parser.parsingErrors[0]).toMatch(message);
    expect(parser.parse('a =~ /ok/')).toBeDefined();
  }
  expect(ContextKeyExpr.deserialize(text)).toBeUndefined();
});

test('nesting deep enough to overflow the stack is a syntax error, not an exception', () => {
  const parser = new Parser();
  const text = '('.repeat(200_000) + 'a' + ')'.repeat(200_000);
  expect(() => parser.parse(text)).not.toThrow();
  expect(parser.parse(text)).toBeUndefined();
  expect(parser.parsingErrors).toHaveLength(1);
});

test.each([
  ['a in b', ['a', 'b']],
  ['a not in b', ['a', 'b']],
  ['!(a in b)', ['a', 'b']],
  ['a in a', ['a']],
  ['n > 1', ['n']],
  ['!(n >= 1)', ['n']],
  ['a =~ /x/', ['a']],
  ['!(a =~ /x/)', ['a']],
  ['x && a in b || n < 2', ['x', 'a', 'b', 'n']],
])('%s depends on %j', (text, keys) => {
  expect(parse(text).keys()).toEqual(keys);
});

test('the factories build the same expressions the parser reads', () => {
  for (const [built, text] of [
    [ContextKeyExpr.regex('a', /x/gi), 'a =~ /x/i'],
    [ContextKeyExpr.in('a', 'b'), "a in 'b'"],
    [ContextKeyExpr.notIn('a', 'b'), "a not in 'b'"],
    [ContextKeyExpr.greater('n', 1), 'n > 1'],
    [ContextKeyExpr.greaterEquals('n', '1'), 'n >= 1'],
    [ContextKeyExpr.smaller('n', 1), 'n < 1'],
    [ContextKeyExpr.smallerEquals('n', 'x y'), "n <= 'x y'"],
  ] as const) {
    expect(built.serialize()).toBe(text);
    expect(parse(text).serialize()).toBe(text);
  }
});

// The cases of VS Code's parser tests (src/vs/platform/contextkey/test/common/parser.test.ts), plus the
// operators' edges. Upstream normalizes what it reads (sorting terms, distributing `!` over `&&`); this parser
// keeps the author's order, so only acceptance is compared, and the text shown is this parser's.
test.each([
  [' foo', 'foo'],
  ['!foo', '!foo'],
  ['foo =~ /bar/', 'foo =~ /bar/'],
  ['foo || (foo =~ /bar/ && baz)', 'foo || foo =~ /bar/ && baz'],
  ['foo || (foo =~ /bar/ || baz)', 'foo || foo =~ /bar/ || baz'],
  ['(foo || bar) && (jee || jar)', '(foo || bar) && (jee || jar)'],
  ['foo && foo =~ /zee/i', 'foo && foo =~ /zee/i'],
  ['foo.bar==enabled', "foo.bar == 'enabled'"],
  ["foo.bar == 'enabled'", "foo.bar == 'enabled'"],
  ['foo.bar:zed==completed', "foo.bar:zed == 'completed'"],
  ['a && b || c', 'a && b || c'],
  ['fooBar && baz.jar && fee.bee<K-loo+1>', 'fooBar && baz.jar && fee.bee<K-loo+1>'],
  ['foo.barBaz<C-r> < 2', 'foo.barBaz<C-r> < 2'],
  ['foo.bar >= -1', 'foo.bar >= -1'],
  ['foo.bar <= -1', 'foo.bar <= -1'],
  ['view == vsc-packages-activitybar-folders && vsc-packages-folders-loaded',
    "view == 'vsc-packages-activitybar-folders' && vsc-packages-folders-loaded"],
  ['!cmake:hideBuildCommand \u0026\u0026 cmake:enableFullFeatureSet', '!cmake:hideBuildCommand && cmake:enableFullFeatureSet'],
  ['!(foo && bar)', '!(foo && bar)'],
  ['!(foo && bar || boar) || deer', '!(foo && bar || boar) || deer'],
  ['!(!foo)', '!!foo'],
  ['debugState == "stopped"', `debugState == '"stopped"'`],
  // Values VS Code reads for the sake of existing extensions.
  ['foo == ', "foo == ''"],
  ['(foo != )', "foo != ''"],
  ['languageId == in', "languageId == 'in'"],
  ['a in', "a in ''"],
  ['a not in true', "a not in 'true'"],
  ['a<1', 'a<1'],
  ['a === true', 'a'],
  ["a == 'true'", "a == 'true'"],
  // Without error recovery these regexes end at the first unescaped slash; VS Code's parser glues them back.
  ['resource =~ //foo/(barr|door/(Foo-Bar%20Templates|Soo%20Looo)|Web%20Site%Jjj%20Llll)(/.*)*$/',
    String.raw`resource =~ /\/foo\/(barr|door\/(Foo-Bar%20Templates|Soo%20Looo)|Web%20Site%Jjj%20Llll)(\/.*)*$/`],
  ['resource =~ /((/scratch/(?!update)(.*)/)|((/src/).*/)).*$/',
    String.raw`resource =~ /((\/scratch\/(?!update)(.*)\/)|((\/src\/).*\/)).*$/`],
  [String.raw`resourcePath =~ /\.md(\.yml|\.txt)*$/giym`, String.raw`resourcePath =~ /\.md(\.yml|\.txt)*$/im`],
  ["a =~ '/x/i'", 'a =~ /x/i'],
  ['a =~ /x/d', 'a =~ /x/d'],
  // VS Code counts the escaped parenthesis as a group and glues the `)` on, then rejects the regex.
  [String.raw`(a =~ /\(/)`, String.raw`a =~ /\(/`],
  // VS Code rejects `!!`; this parser has always read it.
  ['!!foo', '!!foo'],
])('the parser reads %s', (text, serialized) => {
  expect(parse(text).serialize()).toBe(serialized);
});

test.each([
  '',
  '/foo',
  "!b == 'true'",
  '!foo &&  in bar',
  'vim<c-r> == 1 && vim<2<=3',
  "foo && 'bar",
  'config.foo &&  &&bar =~ /^foo$|^bar-foo$|^joo$|^jar$/ && !foo',
  "!foo == 'test'",
  ' viewItem == VSCode WorkSpace',
  'not',
  'in',
  'a not',
  'a not b',
  'a in b c',
  '!a in b',
  '!a > 1',
  '!a =~ /x/',
  '(a) == b',
  'true == a',
  'a == /x/',
  'a = b',
  'a & b',
  'a | b',
  'a == b == c',
  'a > > 1',
  // The unescaped slash before `)` opens a regex that never closes; VS Code glues the rest on and fails too.
  '(resource =~ /src//) && b',
  // VS Code silently skips a character it has no rule for; this parser reports it.
  'a {',
])('the parser rejects %s', text => {
  const parser = new Parser();
  expect(parser.parse(text)).toBeUndefined();
  expect(parser.parsingErrors).toHaveLength(1);
  expect(new Parser({ regexParsingWithErrorRecovery: false }).parse(text)).toBeUndefined();
});

test.each([
  'resource =~ //foo/',
  "a =~ '/x/i'",
  'a =~ /x/d',
])('without regex recovery, as in ContextKeyExpr.deserialize, %s is rejected', text => {
  expect(ContextKeyExpr.deserialize(text)).toBeUndefined();
  const parser = new Parser({ regexParsingWithErrorRecovery: false });
  expect(parser.parse(text)).toBeUndefined();
  expect(parser.parsingErrors).toHaveLength(1);
  expect(new Parser().parse(text)).toBeDefined();
});
