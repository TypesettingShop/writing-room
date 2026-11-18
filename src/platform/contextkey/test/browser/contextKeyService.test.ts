import { expect, test, vi } from 'vitest';
import { ContextKeyService } from '../../browser/contextKeyService.js';
import { ContextKeyExpr, Parser, RawContextKey } from '../../common/contextkey.js';

test.each([
  ['a || b && c', true],
  ['!a && b', false],
  ['(a || b) && c', false],
  ["k == 'two words'", true],
  ['k != x', true],
  ['n == 10', true],
  ['k == true', true],
  ['missing == false', true],
  ['missing != false', false],
  ["k == 'true'", false],
  ['!(a || b)', false],
  ['!!a', true],
  ['false', false],
  ['true', true],
])('evaluates %s', (text, expected) => {
  const root = new ContextKeyService();
  try {
    for (const [key, value] of Object.entries({ a: true, b: true, c: false, k: 'two words', n: 10 })) {
      root.createKey(key, value);
    }
    const expression = ContextKeyExpr.deserialize(text);
    expect(expression).toBeDefined();
    expect(root.contextMatchesRules(expression)).toBe(expected);
    expect(root.contextMatchesRules(ContextKeyExpr.deserialize(expression!.serialize()))).toBe(expected);
  } finally {
    root.dispose();
  }
});

test.each(['a =~ /x/', 'a in b', 'a not in b', 'n > 1', 'a &&', '(a', "a == 'oops", 'a === b'])(
  'reports a syntax error for %s', text => {
    const parser = new Parser();
    expect(parser.parse(text)).toBeUndefined();
    expect(parser.parsingErrors).toHaveLength(1);
    expect(ContextKeyExpr.deserialize(text)).toBeUndefined();
    expect(parser.parse('a')).toBeDefined();
    expect(parser.parsingErrors).toHaveLength(0);
  },
);

test('inherits context and selects the nearest scope, including across a shadow root', () => {
  const root = new ContextKeyService();
  const host = document.createElement('div');
  const nested = document.createElement('div');
  const button = document.createElement('button');
  host.attachShadow({ mode: 'open' }).append(nested);
  nested.append(button);
  const branch = root.createScoped(host);
  const child = branch.createScoped(nested);
  const sibling = root.createScoped(document.createElement('div'));
  try {
    const key = new RawContextKey<string>('view', undefined);
    const shared = new RawContextKey<boolean>('enabled', false);
    const parentValue = key.bindTo(root);
    parentValue.set('root');
    const observed = vi.fn();
    child.onDidChangeContext(event => { if (event.affectsSome(new Set(['view']))) observed(); });
    expect(child.contextMatchesRules(undefined)).toBe(true);
    expect(root.getContext(button).getValue('view')).toBe('root');
    shared.bindTo(branch).set(true);
    expect(observed).not.toHaveBeenCalled();
    expect(child.getContextKeyValue('enabled')).toBe(true);
    expect(sibling.getContextKeyValue('enabled')).toBeUndefined();

    const local = key.bindTo(child);
    local.set('nested');
    parentValue.set('updated');
    expect(observed).toHaveBeenCalledTimes(1);
    expect(root.getContext(button).getValue('view')).toBe('nested');
    expect(sibling.getContextKeyValue('view')).toBe('updated');

    local.reset();
    expect(observed).toHaveBeenCalledTimes(2);
    expect(local.get()).toBe('updated');
    child.dispose();
    expect(root.getScopedContextKeyService(button)).toBe(branch);
  } finally {
    child.dispose();
    sibling.dispose();
    branch.dispose();
    root.dispose();
  }
});
