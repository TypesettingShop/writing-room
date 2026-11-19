import { expect, test, vi } from 'vitest';
import { Configuration, configurationChange } from '../../common/configurationModels.js';
import { ConfigurationRegistry, validateConfigurationValue } from '../../common/configurationRegistry.js';
import type { IConfigurationNode, IConfigurationProblem } from '../../common/configurationRegistry.js';
import { NullConfigurationService } from '../../common/configuration.js';
import { configurationRegistry } from '../../common/configurationRegistry.js';

function build(registry: ConfigurationRegistry, user: Record<string, unknown> = {}): Configuration {
  return Configuration.build(registry.getConfigurationProperties(), registry.getLanguageDefaults(), user);
}

// Each of the four layers is there or not: the default, the default for markdown, the user's value and
// the user's value for markdown. A language's own value wins over a value for every language; within
// each, the user's wins over the default.
test.each(Array.from({ length: 16 }, (_, mask) => mask))('reads layer combination %i in VS Code order', mask => {
  const [hasDefault, hasDefaultLanguage, hasUser, hasUserLanguage] = [1, 2, 4, 8].map(bit => (mask & bit) !== 0);
  const registry = new ConfigurationRegistry();
  registry.registerConfiguration({
    id: 'test', properties: { 'test.value': hasDefault ? { type: 'string', default: 'default' } : { type: 'string' } },
  });
  if (hasDefaultLanguage) {
    registry.registerDefaultConfigurations([{ overrides: { '[markdown]': { 'test.value': 'default markdown' } }, source: 'ext' }]);
  }
  const user: Record<string, unknown> = {};
  if (hasUser) {
    user['test.value'] = 'user';
  }
  if (hasUserLanguage) {
    user['[markdown]'] = { 'test.value': 'user markdown' };
  }
  const configuration = build(registry, user);
  const base = hasUser ? 'user' : hasDefault ? 'default' : '';
  const markdown = hasUserLanguage ? 'user markdown' : hasDefaultLanguage ? 'default markdown' : base;
  expect(configuration.getValue('test.value')).toBe(base);
  expect(configuration.getValue('test.value', { overrideIdentifier: 'markdown' })).toBe(markdown);
  expect(configuration.getValue('test.value', { overrideIdentifier: 'plaintext' })).toBe(base);
  expect(configuration.getValue('test', { overrideIdentifier: 'markdown' })).toEqual({ value: markdown });
});

test('accepts every manifest type, a union of types, enums and ranges, and only those', () => {
  const union = { type: ['boolean', 'integer'] } as const;
  expect(validateConfigurationValue(union, true)).toBe(true);
  expect(validateConfigurationValue(union, 3)).toBe(true);
  expect(validateConfigurationValue(union, 3.5)).toBe(false);
  expect(validateConfigurationValue(union, '3')).toBe(false);
  expect(validateConfigurationValue({ type: 'array' }, [1])).toBe(true);
  expect(validateConfigurationValue({ type: 'array' }, {})).toBe(false);
  expect(validateConfigurationValue({ type: 'object' }, { a: [1] })).toBe(true);
  expect(validateConfigurationValue({ type: 'object' }, [])).toBe(false);
  expect(validateConfigurationValue({ type: 'object' }, null)).toBe(false);
  expect(validateConfigurationValue({ type: 'null' }, null)).toBe(true);
  expect(validateConfigurationValue({ type: 'string', enum: ['a', 'b'] }, 'c')).toBe(false);
  expect(validateConfigurationValue({ type: 'number', minimum: 1, maximum: 2 }, 3)).toBe(false);
  expect(validateConfigurationValue({ type: 'number' }, Number.NaN)).toBe(false);
  expect(validateConfigurationValue({}, { anything: true })).toBe(true);
});

test('falls back to the default for a user value of the wrong type, also for a language', () => {
  const registry = new ConfigurationRegistry();
  registry.registerConfiguration({ id: 'lint', properties: { 'lint.level': { type: ['boolean', 'integer'], default: false } } });
  const configuration = build(registry, { 'lint.level': 'high', '[markdown]': { 'lint.level': 3 }, '[json]': { 'lint.level': '3' } });
  expect(configuration.getValue('lint.level')).toBe(false);
  expect(configuration.getValue('lint.level', { overrideIdentifier: 'markdown' })).toBe(3);
  expect(configuration.getValue('lint.level', { overrideIdentifier: 'json' })).toBe(false);
});

test('gives every reader its own copy of object and array values, and never merges objects', () => {
  const registry = new ConfigurationRegistry();
  registry.registerConfiguration({
    id: 'lint', properties: {
      'lint.config': { type: 'object', default: { MD013: true, MD033: true } },
      'lint.ignore': { type: 'array', default: ['a'] },
    },
  });
  const configuration = build(registry, { 'lint.config': { MD013: false } });
  const read = configuration.getValue<Record<string, unknown>>('lint.config')!;
  expect(read).toEqual({ MD013: false });
  read.MD013 = 'changed';
  (configuration.getValue<string[]>('lint.ignore')!).push('b');
  (configuration.getValue<{ config: Record<string, unknown> }>('lint')!).config.extra = 1;
  expect(configuration.getValue('lint.config')).toEqual({ MD013: false });
  expect(configuration.getValue('lint.ignore')).toEqual(['a']);
  expect(configuration.getValue('lint.config.MD013')).toBe(false);
  expect(configuration.inspect('lint.config').defaultValue).toEqual({ MD013: true, MD033: true });
});

test('reads languages from sections naming several; a section naming one language wins over them wherever it stands', () => {
  const registry = new ConfigurationRegistry();
  registry.registerConfiguration({ id: 'test', properties: { 'test.size': { type: 'number', default: 1 } } });
  const configuration = build(registry, { '[markdown][plaintext]': { 'test.size': 2 }, '[plaintext]': { 'test.size': 3 } });
  expect(configuration.getValue('test.size', { overrideIdentifier: 'markdown' })).toBe(2);
  expect(configuration.getValue('test.size', { overrideIdentifier: 'plaintext' })).toBe(3);
  expect(configuration.inspect('test.size', { overrideIdentifier: 'markdown' })).toEqual({
    value: 2, defaultValue: 1, userValue: 2,
    default: { value: 1, override: undefined }, user: { value: undefined, override: 2 },
    overrideIdentifiers: ['markdown', 'plaintext'],
  });
});

test('registers what is valid, reports the rest with both owners, and throws without a reporter', () => {
  const registry = new ConfigurationRegistry();
  registry.registerConfiguration({ id: 'editor', properties: { 'editor.fontSize': { type: 'number', default: 14 } } });
  const problems: IConfigurationProblem[] = [];
  const node: IConfigurationNode = {
    id: 'a', extensionId: 'pub.a', properties: {
      'editor.fontSize': { type: 'number', default: 12 },
      'a.__proto__.x': { type: 'string' },
      'a.bad': { type: 'string', default: 1 },
      'a.good': { type: 'string', default: 'ok' },
    },
  };
  registry.registerConfigurations([node], problem => problems.push(problem));
  expect(problems.map(({ source, key }) => source + ' ' + key)).toEqual(['pub.a editor.fontSize', 'pub.a a.__proto__.x']);
  expect(problems[0].message).toContain("already registered by 'editor'");
  // As in VS Code, a default that does not match its type is no reason to refuse the property.
  expect([...registry.getConfigurationProperties().keys()]).toEqual(['editor.fontSize', 'a.bad', 'a.good']);
  expect(registry.getConfigurationProperties().get('a.bad')?.default).toBe(1);
  expect(() => registry.registerConfiguration({ id: 'b', properties: { 'b.ok': { type: 'string' }, 'a.good.x': { type: 'string' } } }))
    .toThrow("'a.good.x'");
  expect(registry.getConfigurationProperties().has('b.ok')).toBe(false);
});

test('deregisters properties and defaults, and fires one update per change', () => {
  const registry = new ConfigurationRegistry();
  const updated = vi.fn();
  registry.onDidUpdateConfiguration(updated);
  const node: IConfigurationNode = { id: 'x', properties: { 'x.wrap': { type: 'string', default: 'off' } } };
  const defaults = { overrides: { 'x.wrap': 'bounded', '[markdown]': { 'x.wrap': 'on', 'x.unknown': 1 } }, source: 'ext' };
  registry.updateConfigurations({ add: [node], addDefaults: [defaults] });
  expect(updated).toHaveBeenCalledOnce();
  const before = build(registry, { 'x.wrap': 'off' });
  expect(before.getValue('x.wrap')).toBe('off');
  expect(before.inspect('x.wrap').defaultValue).toBe('bounded');
  expect(before.getValue('x.wrap', { overrideIdentifier: 'markdown' })).toBe('on');

  registry.deregisterDefaultConfigurations([defaults]);
  const withoutDefaults = build(registry, {});
  expect(withoutDefaults.getValue('x.wrap')).toBe('off');
  expect(withoutDefaults.getValue('x.wrap', { overrideIdentifier: 'markdown' })).toBe('off');
  registry.deregisterConfigurations([node]);
  const after = build(registry, { 'x.wrap': 'on' });
  expect(after.getValue('x.wrap')).toBeUndefined();
  expect(updated).toHaveBeenCalledTimes(3);
  const change = configurationChange(withoutDefaults, after)!;
  expect([...change.affectedKeys]).toEqual(['x.wrap']);
});

test('reports a default override that does not match the registered schema and keeps the rest', () => {
  const registry = new ConfigurationRegistry();
  registry.registerConfiguration({ id: 'x', properties: { 'x.size': { type: 'number', default: 1 }, 'x.on': { type: 'boolean', default: false } } });
  const problems: IConfigurationProblem[] = [];
  registry.registerDefaultConfigurations([{ overrides: { 'x.size': 'big', '[md]': { 'x.on': 'yes', 'x.size': 4 } }, source: 'ext' }],
    problem => problems.push(problem));
  expect(problems.map(problem => problem.key)).toEqual(['x.size', '[md].x.on']);
  const configuration = build(registry);
  expect(configuration.getValue('x.size')).toBe(1);
  expect(configuration.getValue('x', { overrideIdentifier: 'md' })).toEqual({ size: 4, on: false });
});

test('tells language changes apart in change events', () => {
  const registry = new ConfigurationRegistry();
  registry.registerConfiguration({ id: 'editor', properties: { 'editor.wrap': { type: 'string', default: 'off' } } });
  const previous = build(registry, {});
  const next = build(registry, { '[markdown]': { 'editor.wrap': 'on' } });
  const change = configurationChange(previous, next)!;
  expect(change.affectsConfiguration('editor')).toBe(true);
  expect(change.affectsConfiguration('editor.wrap')).toBe(true);
  expect(change.affectsConfiguration('edit')).toBe(false);
  expect(change.affectsConfiguration('editor.wrap.deeper')).toBe(false);
  expect(change.affectsConfiguration('editor', { overrideIdentifier: 'markdown' })).toBe(true);
  expect(change.affectsConfiguration('editor', { overrideIdentifier: 'plaintext' })).toBe(false);
  expect(configurationChange(next, build(registry, { '[markdown]': { 'editor.wrap': 'on' }, unknown: 1 }))).toBeUndefined();
});

test('the service without settings.json gives the registered defaults', () => {
  const node: IConfigurationNode = { id: 'null.test', properties: { 'nullTest.value': { type: 'integer', default: 7 } } };
  configurationRegistry.registerConfiguration(node);
  try {
    const service = new NullConfigurationService();
    expect(service.getValue('nullTest.value')).toBe(7);
    expect(service.getValue('nullTest')).toEqual({ value: 7 });
    expect(service.inspect('nullTest.value').defaultValue).toBe(7);
  } finally {
    configurationRegistry.deregisterConfigurations([node]);
  }
});

test('a section naming one language wins over a later one naming several, in user values and in defaults', () => {
  const registry = new ConfigurationRegistry();
  registry.registerConfiguration({ id: 'test', properties: { 'test.size': { type: 'number', default: 1 }, 'test.on': { type: 'boolean', default: false } } });
  registry.registerDefaultConfigurations([
    { overrides: { '[markdown]': { 'test.on': true } }, source: 'a' },
    { overrides: { '[markdown][plaintext]': { 'test.on': false } }, source: 'b' },
  ]);
  const configuration = build(registry, {
    '[markdown]': { 'test.size': 30 },
    '[markdown][plaintext]': { 'test.size': 20 },
    '[json][markdown]': { 'test.size': 25 },
  });
  expect(configuration.getValue('test', { overrideIdentifier: 'markdown' })).toEqual({ size: 30, on: true });
  expect(configuration.getValue('test', { overrideIdentifier: 'plaintext' })).toEqual({ size: 20, on: false });
  expect(configuration.getValue('test.size', { overrideIdentifier: 'json' })).toBe(25);
});
