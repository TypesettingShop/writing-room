// @vitest-environment node
import type * as vscode from 'vscode';
import { afterEach, expect, test, vi } from 'vitest';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IMonacoTextModel, MonacoNamespace } from '../../../../editor/browser/monaco.js';
import type { IPosition } from '../../../../editor/common/model.js';
import { MODEL_SYNC_LIMIT } from '../../../../editor/common/model.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import { checkRegExp, checkSelector, request, toMonacoLanguageConfiguration } from '../../browser/mainThreadLanguageFeatures.js';
import type { MainThreadLanguageFeatures } from '../../browser/mainThreadLanguageFeatures.js';
import { checkSelector as checkApiSelector, IndentAction } from '../../common/extHostLanguageFeatures.js';
import type { ExtHostLanguageFeatures } from '../../common/extHostLanguageFeatures.js';
import { positionFromEditor } from '../../common/extHostTypeConverters.js';
import { Position, RelativePattern, Uri } from '../../common/extHostTypes.js';
import { createLanguageFeatureTestHost, settle as settleHost, testExtensions, testModel, workspaceUri } from './languageFeaturesTestHost.js';

/*
 * The seam with a feature of the test's own: `registerTestProvider` on the extension host, a Monaco
 * "TestProvider" on the workbench side that asks `$provideTest` with a URI and a position.
 */

const text = ['# Title', 'SECRET body text that must not cross', 'last'];
const resource = workspaceUri('a.md');
const extensions = testExtensions;

interface TestProvider { provideTest(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<string> }

class TestAdapter {
  constructor(readonly provider: TestProvider) {}
}

function testGroup(features: ExtHostLanguageFeatures) {
  return {
    api: (extension: HostExtensionDescription) => ({
      registerTestProvider: (selector: vscode.DocumentSelector, provider: TestProvider) => {
        const dto = checkApiSelector(selector);
        return features.register(extension, new TestAdapter(provider), handle =>
          (features.proxy as unknown as { $registerTestSupport(key: string, handle: number, selector: unknown): Promise<void> })
            .$registerTestSupport(extension.key, handle, dto));
      },
      registerTestCommand: (command: vscode.Command) => features.createCommandStore(extension).toDto(command),
    }),
    $provideTest(handle: number, uri: URI, position: IPosition, token: CancellationToken): Promise<string | undefined> {
      return features.invoke(handle, TestAdapter, token, undefined, async (adapter, extension) => {
        const document = features.document(extension, uri);
        return document ? await adapter.provider.provideTest(document, positionFromEditor(position), token) ?? undefined : undefined;
      });
    },
  };
}

interface FakeProvider { provideTest(model: IMonacoTextModel, position: IPosition, token: CancellationToken): Promise<string | undefined> }

function mainTestGroup(seam: MainThreadLanguageFeatures) {
  return {
    $registerTestSupport(extension: string, handle: number, selector: unknown): Promise<void> {
      const checked = checkSelector(selector);
      return seam.register(extension, handle, monaco => (monaco.languages as unknown as Record<string, Function>).registerTestProvider(checked, {
        provideTest: (model, position, token) => request(model, token, uri =>
          (seam.proxy as unknown as { $provideTest(handle: number, uri: URI, position: IPosition, token: CancellationToken): Promise<string | undefined> })
            .$provideTest(handle, uri, position, token)),
      } satisfies FakeProvider));
    },
  };
}

const model = (length?: number) => testModel(resource, text.join('\n'), { length });

let host: Awaited<ReturnType<typeof createLanguageFeatureTestHost>> | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
  vi.restoreAllMocks();
});

async function setup(options: { monaco?: () => Promise<MonacoNamespace> } = {}) {
  host = await createLanguageFeatureTestHost({
    hostGroups: [testGroup], mainGroups: [mainTestGroup], documents: [{ uri: resource, text: text.join('\n') }], monaco: options.monaco,
  });
  const api = host.api as unknown as (key: string) => ReturnType<ReturnType<typeof testGroup>['api']>;
  const providers = { get size() { return host!.of('TestProvider').length; }, [Symbol.iterator]: () => host!.of('TestProvider').map(entry => entry.provider as FakeProvider)[Symbol.iterator]() };
  return { ...host, api, providers, configurations: host.configurations };
}

const settle = settleHost;

test('a call carries the URI and the position, the provider gets the document and a 0-based position', async () => {
  const { api, providers, sent } = await setup();
  const provideTest = vi.fn((document: vscode.TextDocument, position: vscode.Position) => document.lineAt(position.line).text.slice(position.character));
  api('1').registerTestProvider({ language: 'markdown' }, { provideTest });
  await settle();
  expect(providers.size).toBe(1);
  const [provider] = providers;
  expect(host!.of('TestProvider')[0].selector).toEqual({ language: 'markdown' });
  sent.length = 0;
  await expect(provider.provideTest(model(), { lineNumber: 2, column: 8 }, new CancellationTokenSource().token)).resolves.toBe('body text that must not cross');
  expect(provideTest.mock.calls[0][1]).toEqual(new Position(1, 7));
  // Only identifiers and positions crossed, never the text.
  expect(JSON.stringify(sent)).not.toContain('SECRET');
  expect(sent).toContainEqual(expect.objectContaining({ kind: 'request', method: '$provideTest', args: [1, expect.objectContaining({ scheme: 'vscode-vfs', path: '/workspace/a.md', $mid: 1 }), { lineNumber: 2, column: 8 }] }));
});

test('a provider that throws gives nothing and is logged with the public identifier; the other provider still answers', async () => {
  const { api, providers } = await setup();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  api('1').registerTestProvider('markdown', { provideTest: () => { throw new Error('broken provider'); } });
  api('2').registerTestProvider('markdown', { provideTest: () => 'second' });
  await settle();
  const results = await Promise.all([...providers].map(provider => provider.provideTest(model(), { lineNumber: 1, column: 1 }, new CancellationTokenSource().token)));
  expect(results).toEqual([undefined, 'second']);
  expect(error).toHaveBeenCalledTimes(1);
  expect(String(error.mock.calls[0][0])).toContain('[test.first]');
  expect(String(error.mock.calls[0][0])).not.toMatch(/\[1\]/);
});

test('cancelling on the workbench side cancels the provider\'s token, and its late answer is not used', async () => {
  const { api, providers } = await setup();
  let providerToken: vscode.CancellationToken | undefined;
  let answer!: (value: string) => void;
  api('1').registerTestProvider('markdown', {
    provideTest: (_document, _position, token) => {
      providerToken = token;
      return new Promise<string>(resolve => { answer = resolve; });
    },
  });
  await settle();
  const source = new CancellationTokenSource();
  const result = [...providers][0].provideTest(model(), { lineNumber: 1, column: 1 }, source.token);
  await settle();
  expect(providerToken?.isCancellationRequested).toBe(false);
  source.cancel();
  await settle();
  expect(providerToken?.isCancellationRequested).toBe(true);
  answer('late');
  await expect(result).resolves.toBeUndefined();
});

test('the extension host answers a cancelled call at once, without waiting for the provider', async () => {
  const { api, features } = await setup();
  api('1').registerTestProvider('markdown', { provideTest: () => new Promise<string>(() => {}) });
  await settle();
  const source = new CancellationTokenSource();
  const handler = (features as unknown as { registrations: Map<number, unknown> });
  const [handle] = handler.registrations.keys();
  const result = (testGroup(features)).$provideTest(handle, resource, { lineNumber: 1, column: 1 }, source.token);
  source.cancel();
  await expect(result).resolves.toBeUndefined();
});

test('a model above the synchronization limit, or a cancelled request, never reaches the extension host', async () => {
  const { api, providers, sent } = await setup();
  const provideTest = vi.fn(() => 'x');
  api('1').registerTestProvider('*', { provideTest });
  await settle();
  sent.length = 0;
  const [provider] = providers;
  await expect(provider.provideTest(model(MODEL_SYNC_LIMIT + 1), { lineNumber: 1, column: 1 }, new CancellationTokenSource().token)).resolves.toBeUndefined();
  const cancelled = new CancellationTokenSource();
  cancelled.cancel();
  await expect(provider.provideTest(model(), { lineNumber: 1, column: 1 }, cancelled.token)).resolves.toBeUndefined();
  expect(provideTest).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
});

test('disposing, removing the extension or ending the host takes every Monaco registration back', async () => {
  const { api, providers, workbench, host: area } = await setup();
  const first = api('1').registerTestProvider('markdown', { provideTest: () => 'a' });
  api('1').registerTestProvider('markdown', { provideTest: () => 'b' });
  api('2').registerTestProvider('markdown', { provideTest: () => 'c' });
  await settle();
  expect(workbench.seam.registrationCount).toBe(3);
  expect(providers.size).toBe(3);

  const [provider] = providers;
  first.dispose();
  await settle();
  expect(providers.size).toBe(2);
  expect(area.features.size).toBe(2);
  // A request that was on its way when the registration went answers with nothing.
  await expect(provider.provideTest(model(), { lineNumber: 1, column: 1 }, new CancellationTokenSource().token)).resolves.toBeUndefined();

  workbench.seam.remove('1');
  expect(providers.size).toBe(1);
  area.features.release('1');
  await settle();
  expect(area.features.size).toBe(1);

  workbench.dispose();
  expect(providers.size).toBe(0);
  expect(workbench.seam.registrationCount).toBe(0);
});

test('the extension\'s release unregisters on the workbench side too', async () => {
  const { api, providers, features } = await setup();
  api('1').registerTestProvider('markdown', { provideTest: () => 'a' });
  api('2').registerTestProvider('markdown', { provideTest: () => 'b' });
  await settle();
  features.release('1');
  await settle();
  expect(providers.size).toBe(1);
});

test('registrations wait for the editor package, and one disposed before it loads is never made', async () => {
  let load!: (monaco: MonacoNamespace) => void;
  const loading = new Promise<MonacoNamespace>(resolve => { load = resolve; });
  const { api, providers, workbench, monaco } = await setup({ monaco: () => loading });
  const early = api('1').registerTestProvider('markdown', { provideTest: () => 'a' });
  api('2').registerTestProvider('markdown', { provideTest: () => 'b' });
  await settle();
  early.dispose();
  await settle();
  expect(providers.size).toBe(0);
  load(monaco);
  await settle();
  expect(providers.size).toBe(1);
  expect(workbench.seam.registrationCount).toBe(1);
});

test('the workbench refuses a handle of another extension, a reused handle and a selector of another shape', async () => {
  const { workbench } = await setup();
  const handlers = workbench.handlers as Record<string, (...args: unknown[]) => Promise<void>>;
  await expect(handlers.$registerTestSupport('9', 1, 'markdown')).rejects.toThrow('not registered');
  await handlers.$registerTestSupport('1', 7, 'markdown');
  await expect(handlers.$registerTestSupport('2', 7, 'markdown')).rejects.toThrow('handle');
  // Another extension cannot take the registration back.
  await handlers.$unregister('2', 7);
  expect(workbench.seam.registrationCount).toBe(1);
  expect(() => checkSelector(42)).toThrow();
  expect(() => checkSelector([{ language: 1 }])).toThrow();
  expect(() => checkSelector(new Array(65).fill('*'))).toThrow();
  expect(checkSelector([{ language: 'markdown', scheme: 'untitled', pattern: { base: '/workspace', pattern: '*.md' }, extra: 'dropped' }]))
    .toEqual([{ language: 'markdown', scheme: 'untitled', pattern: { base: '/workspace', pattern: '*.md' } }]);
});

test('selectors cross as strings and filters; a relative pattern carries its base path', () => {
  const base = Uri.parse('vscode-vfs://writing-room/workspace/docs');
  expect(checkApiSelector([{ language: 'markdown' }, 'plaintext', { scheme: 'untitled' }])).toEqual([{ language: 'markdown' }, 'plaintext', { scheme: 'untitled' }]);
  expect(checkApiSelector({ pattern: new RelativePattern(base, '*.md') })).toEqual({
    pattern: { base: '/workspace/docs', baseUri: base, pattern: '*.md' },
  });
  expect(() => checkApiSelector(7 as never)).toThrow(TypeError);
  expect(() => checkApiSelector({ pattern: 3 } as never)).toThrow(TypeError);
});

test('languages.match scores like VS Code', async () => {
  const { features: { match }, features, document: find } = await setup();
  const document = find(resource);
  const host = { features: { match: match.bind(features) } };
  expect(host.features.match('markdown', document)).toBe(10);
  expect(host.features.match({ language: 'plaintext' }, document)).toBe(0);
  expect(host.features.match(['plaintext', '*'], document)).toBe(5);
  expect(host.features.match({ scheme: 'vscode-vfs', pattern: '**/*.md' }, document)).toBe(10);
  expect(host.features.match({ pattern: new RelativePattern(Uri.parse('vscode-vfs://writing-room/workspace'), '*.md') }, document)).toBe(10);
  expect(host.features.match({ pattern: new RelativePattern(Uri.parse('vscode-vfs://writing-room/other'), '*.md') }, document)).toBe(0);
});

test('a language configuration reaches Monaco with its regular expressions, and its word pattern is the document\'s default', async () => {
  const { features, configurations, document: find, workbench } = await setup();
  const host = { features };
  const document = find(resource);
  expect(document.getWordRangeAtPosition(new Position(1, 8))?.end.character).toBe(11);
  const registration = host.features.setLanguageConfiguration(extensions['1'], 'markdown', {
    comments: { blockComment: ['<!--', '-->'] },
    brackets: [['[', ']'], ['(', ')']],
    wordPattern: /[\w ]+/u,
    onEnterRules: [{ beforeText: /^\s*-/, action: { indentAction: IndentAction.None, appendText: '- ' } }],
    autoClosingPairs: [{ open: '`', close: '`', notIn: [2] }],
  });
  await settle();
  expect(configurations).toHaveLength(1);
  const configuration = configurations[0].configuration as Record<string, any>;
  expect(configurations[0].languageId).toBe('markdown');
  expect(configuration.wordPattern).toEqual(/[\w ]+/u);
  expect(configuration.onEnterRules[0].beforeText).toEqual(/^\s*-/);
  expect(configuration.onEnterRules[0].action).toEqual({ indentAction: 0, appendText: '- ', removeText: undefined });
  expect(configuration.brackets).toEqual([['[', ']'], ['(', ')']]);
  expect(configuration.comments).toEqual({ lineComment: undefined, blockComment: ['<!--', '-->'] });
  expect(configuration.autoClosingPairs).toEqual([{ open: '`', close: '`', notIn: ['string'] }]);
  // The document's word without a pattern of its own now follows the language's pattern.
  expect(document.getWordRangeAtPosition(new Position(1, 8))?.end.character).toBe(36);
  registration.dispose();
  await settle();
  expect(configurations).toHaveLength(0);
  expect(workbench.seam.registrationCount).toBe(0);
  expect(document.getWordRangeAtPosition(new Position(1, 8))?.end.character).toBe(11);
  expect(() => host.features.setLanguageConfiguration(extensions['1'], 'markdown', { wordPattern: /x*/ })).toThrow('empty string');
});

test('a provider\'s command crosses as a reference, runs on the extension host with its own arguments, and goes with its store', async () => {
  const { api, features, seam, monaco, run, executed } = await setup();
  const argument = { notCloneable: () => 'kept on the host' };
  const store = features.createCommandStore(extensions['1']);
  const dto = store.toDto({ command: 'fixture.run', title: 'Run', tooltip: 'Runs', arguments: [argument, 2] })!;
  expect(dto).toEqual({ title: 'Run', tooltip: 'Runs', ref: expect.any(Number) });
  expect(store.toDto({ title: 'No id' } as vscode.Command)).toBeUndefined();
  const command = seam.toMonacoCommand(monaco, dto)!;
  expect(command).toEqual({ id: expect.stringMatching(/^_writingRoom\.languageFeatures\.\d+\.run$/), title: 'Run', tooltip: 'Runs', arguments: [dto.ref] });
  run(command);
  await settle();
  expect(executed).toEqual([{ extension: '1', id: 'fixture.run', args: [argument, 2] }]);
  expect(features.commandCount).toBe(1);
  store.dispose();
  expect(features.commandCount).toBe(0);
  run(command);
  await settle();
  expect(executed).toHaveLength(1);
  // A released extension's commands go too.
  api('1').registerTestCommand({ command: 'fixture.other', title: 'Other' });
  features.release('1');
  expect(features.commandCount).toBe(0);
  expect(seam.toMonacoCommand(monaco, { title: 'x', ref: 1.5 })).toBeUndefined();
});

test('the workbench builds regular expressions only from a source and plain flags', () => {
  expect(checkRegExp({ source: 'a+', flags: 'gi' })).toEqual(/a+/i);
  expect(() => checkRegExp({ source: '(', flags: '' })).toThrow();
  expect(() => checkRegExp({ source: 'a', flags: 'x' })).toThrow();
  expect(() => toMonacoLanguageConfiguration({ onEnterRules: [{ beforeText: { source: 'a', flags: '' }, action: { indentAction: 9 } }] })).toThrow();
});
