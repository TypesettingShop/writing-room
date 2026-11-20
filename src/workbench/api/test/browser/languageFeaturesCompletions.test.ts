// @vitest-environment node
import type * as vscode from 'vscode';
import { afterEach, expect, test, vi } from 'vitest';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { IMonacoTextModel } from '../../../../editor/browser/monaco.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { checkMarkdown, createMainThreadCompletions, toHover, toSignatureHelp } from '../../browser/mainThreadLanguageFeaturesCompletions.js';
import { MarkdownString } from '../../common/extHostCommonTypes.js';
import { Position, Range, SnippetString, TextEdit } from '../../common/extHostEditorTypes.js';
import { completionItemKindToDto } from '../../common/extHostLanguageConverters.js';
import { createCompletionsGroup } from '../../common/extHostLanguageFeaturesCompletions.js';
import type { ExtHostCompletions } from '../../common/extHostLanguageFeaturesCompletions.js';
import {
  CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, CompletionTriggerKind, Hover, ParameterInformation, SignatureHelp,
  SignatureHelpTriggerKind, SignatureInformation,
} from '../../common/extHostLanguageFeatureTypes.js';
import { Uri } from '../../common/extHostTypes.js';
import { createLanguageFeatureTestHost, settle, testModel, workspaceUri } from './languageFeaturesTestHost.js';

/*
 * Completions (with resolving), hover and signature help: the extension host's group and the workbench's
 * group over the real RPC, Monaco faked. Each test names the failure it catches.
 */

const resource = workspaceUri('a.lft');
const lines = ['alpha beta', 'call(one, two)', 'last'];
const model = () => testModel(resource, lines.join('\n'), { language: 'lftest' });
const token = () => new CancellationTokenSource().token;
const invoke = { triggerKind: 0 };

type Host = Awaited<ReturnType<typeof createLanguageFeatureTestHost>>;
let host: Host | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
  vi.restoreAllMocks();
});

async function setup() {
  host = await createLanguageFeatureTestHost({
    hostGroups: [createCompletionsGroup], mainGroups: [createMainThreadCompletions], documents: [{ uri: resource, text: lines.join('\n'), language: 'lftest' }],
  });
  const group = host.host.groups[0] as ExtHostCompletions;
  return { ...host, group, languages: (key = '1') => host!.api(key) };
}

/** The Monaco completion provider registered `index`-th. */
const completionProvider = (index = 0) => host!.of('CompletionItemProvider')[index].provider;

async function complete(position = { lineNumber: 1, column: 9 }, context: object = invoke, cancel = token(), index = 0) {
  return completionProvider(index).provideCompletionItems(model(), position, context, cancel);
}

test('items reach Monaco with their labels, kinds, order and fields; a snippet is marked; ranges are insert and replace pairs', async () => {
  const { languages } = await setup();
  const snippet = new SnippetString('beta(${1:value})$0');
  languages().registerCompletionItemProvider('lftest', {
    provideCompletionItems: () => {
      const first = new CompletionItem('beta', CompletionItemKind.Function);
      first.insertText = snippet;
      first.detail = 'detail';
      first.sortText = 'b';
      first.filterText = 'bet';
      first.preselect = true;
      first.commitCharacters = ['(', 7 as never];
      first.tags = [CompletionItemTag.Deprecated];
      first.range = { inserting: new Range(0, 6, 0, 8), replacing: new Range(0, 6, 0, 10) };
      first.additionalTextEdits = [TextEdit.insert(new Position(2, 0), '// added\n')];
      const second = new CompletionItem({ label: 'gamma', detail: '(x)', description: 'module' }, CompletionItemKind.Keyword);
      second.keepWhitespace = true;
      second.range = new Range(0, 6, 0, 10);
      const third = new CompletionItem('delta');
      third.documentation = new MarkdownString('**doc**');
      return [first, second, third, new CompletionItem('epsilon', CompletionItemKind.Snippet), new CompletionItem('')];
    },
  });
  await settle();
  const list = await complete();
  expect(list.suggestions.map((item: { label: unknown }) => item.label)).toEqual(['beta', { label: 'gamma', detail: '(x)', description: 'module' }, 'delta', 'epsilon']);
  // Monaco's kinds: Function 1, Keyword 17, Property 9 (no kind of its own), Snippet 28.
  expect(list.suggestions.map((item: { kind: number }) => item.kind)).toEqual([1, 17, 9, 28]);
  const [beta, gamma, delta] = list.suggestions;
  expect(beta).toMatchObject({
    insertText: 'beta(${1:value})$0', insertTextRules: 4, detail: 'detail', sortText: 'b', filterText: 'bet', preselect: true,
    commitCharacters: ['('], tags: [1],
    range: { insert: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 9 }, replace: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 11 } },
    additionalTextEdits: [{ range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: '// added\n' }],
  });
  expect(gamma).toMatchObject({ insertText: 'gamma', insertTextRules: 1, range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 11 } });
  expect(delta.documentation).toEqual({ value: '**doc**' });
  // Without a range of its own, an item takes the word at the position: inserting up to it, replacing all of it.
  expect(delta.range).toEqual({
    insert: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 9 },
    replace: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 11 },
  });
  expect(list.incomplete).toBe(false);
});

test('every API completion kind maps to the Monaco kind of the same name', async () => {
  const path = 'monaco-editor/editor/common/standalone/standaloneEnums.js';
  const { CompletionItemKind: MonacoKind } = await import(/* @vite-ignore */ path) as { CompletionItemKind: Record<string, number> };
  for (const [name, value] of Object.entries(CompletionItemKind)) {
    if (typeof value === 'number') {
      expect([name, completionItemKindToDto(value)]).toEqual([name, MonacoKind[name]]);
    }
  }
  expect(completionItemKindToDto(99)).toBe(MonacoKind.Property);
});

test('an incomplete list says so, and the provider gets the trigger kind and character; trigger characters reach Monaco', async () => {
  const { languages } = await setup();
  const provide = vi.fn((_document: vscode.TextDocument, _position: vscode.Position, _token: vscode.CancellationToken, _context: vscode.CompletionContext) =>
    new CompletionList([new CompletionItem('one')], true));
  languages().registerCompletionItemProvider('lftest', { provideCompletionItems: provide }, '.', ':');
  await settle();
  expect(completionProvider().triggerCharacters).toEqual(['.', ':']);
  expect((await complete(undefined, { triggerKind: 1, triggerCharacter: '.' })).incomplete).toBe(true);
  expect(provide.mock.calls[0][3]).toEqual({ triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter: '.' });
  await complete(undefined, { triggerKind: 2 });
  expect(provide.mock.calls[1][3]).toEqual({ triggerKind: CompletionTriggerKind.TriggerForIncompleteCompletions, triggerCharacter: undefined });
  expect(provide.mock.calls[1][1]).toEqual(new Position(0, 8));
});

test('resolving runs once per item, fills the documentation and never changes the insert text', async () => {
  const { languages } = await setup();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const resolve = vi.fn((item: vscode.CompletionItem) => {
    item.documentation = new MarkdownString('resolved ' + String(item.label));
    item.detail = 'more';
    item.insertText = 'changed';
    item.additionalTextEdits = [TextEdit.insert(new Position(0, 0), 'x')];
    return item;
  });
  languages().registerCompletionItemProvider('lftest', {
    provideCompletionItems: () => [new CompletionItem('one'), new CompletionItem('two')],
    resolveCompletionItem: resolve,
  });
  await settle();
  const provider = completionProvider();
  const list = await complete();
  const resolved = await provider.resolveCompletionItem(list.suggestions[1], token());
  expect(resolved).toMatchObject({ label: 'two', insertText: 'two', detail: 'more', documentation: { value: 'resolved two' } });
  expect(resolved.additionalTextEdits).toEqual([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'x' }]);
  expect(warn).toHaveBeenCalledTimes(1);
  await provider.resolveCompletionItem(list.suggestions[1], token());
  await provider.resolveCompletionItem(resolved, token());
  expect(resolve).toHaveBeenCalledTimes(1);
  await provider.resolveCompletionItem(list.suggestions[0], token());
  expect(resolve).toHaveBeenCalledTimes(2);
});

test('a provider without resolving gives Monaco no resolver', async () => {
  const { languages } = await setup();
  languages().registerCompletionItemProvider('lftest', { provideCompletionItems: () => [new CompletionItem('one')] });
  await settle();
  expect(completionProvider().resolveCompletionItem).toBeUndefined();
});

test('an item\'s command runs on the extension host with its original arguments, from the list or from resolving', async () => {
  const { languages, run, executed, features } = await setup();
  const argument = { notCloneable: () => 'kept on the host' };
  languages().registerCompletionItemProvider('lftest', {
    provideCompletionItems: () => {
      const item = new CompletionItem('one');
      item.command = { command: 'fixture.accepted', title: 'Accepted', arguments: [argument, 2] };
      return [item, new CompletionItem('two')];
    },
    resolveCompletionItem: item => {
      item.command ??= { command: 'fixture.resolved', title: 'Resolved', arguments: [argument] };
      return item;
    },
  });
  await settle();
  const list = await complete();
  run(list.suggestions[0].command);
  await settle();
  expect(executed).toEqual([{ extension: '1', id: 'fixture.accepted', args: [argument, 2] }]);
  const resolved = await completionProvider().resolveCompletionItem(list.suggestions[1], token());
  run(resolved.command);
  await settle();
  expect(executed[1]).toEqual({ extension: '1', id: 'fixture.resolved', args: [argument] });
  // The commands go with the list.
  list.dispose();
  await settle();
  expect(features.commandCount).toBe(0);
  run(list.suggestions[0].command);
  await settle();
  expect(executed).toHaveLength(2);
});

test('the extension host keeps a list until Monaco disposes it, and the test command counts what it keeps', async () => {
  const { languages, group } = await setup();
  languages().registerCompletionItemProvider('lftest', { provideCompletionItems: () => [new CompletionItem('one')] });
  await settle();
  const first = await complete();
  const second = await complete();
  expect(group.cacheSize).toBe(2);
  await expect(CommandsRegistry.getCommand('_workbench.languageFeatures.completionCacheSize')!.handler(undefined as never)).resolves.toBe(2);
  first.dispose();
  first.dispose();
  await settle();
  expect(group.cacheSize).toBe(1);
  second.dispose();
  await settle();
  expect(group.cacheSize).toBe(0);
  await expect(CommandsRegistry.getCommand('_workbench.languageFeatures.completionCacheSize')!.handler(undefined as never)).resolves.toBe(0);
});

test('fast typing: the cancelled request\'s late list is never shown nor kept, the last request\'s list is', async () => {
  const { languages, group, features } = await setup();
  const answers: ((items: vscode.CompletionItem[]) => void)[] = [];
  const tokens: vscode.CancellationToken[] = [];
  languages().registerCompletionItemProvider('lftest', {
    provideCompletionItems: (_document, _position, providerToken) => {
      tokens.push(providerToken);
      return new Promise<vscode.CompletionItem[]>(resolve => answers.push(resolve));
    },
  });
  await settle();
  const old = new CancellationTokenSource();
  const stale = complete(undefined, invoke, old.token);
  await settle();
  // Monaco cancels the older request when the next keystroke asks again.
  old.cancel();
  const fresh = complete({ lineNumber: 1, column: 10 });
  await settle();
  expect(tokens[0].isCancellationRequested).toBe(true);
  const withCommand = new CompletionItem('stale');
  withCommand.command = { command: 'fixture.stale', title: 'Stale' };
  answers[0]([withCommand]);
  answers[1]([new CompletionItem('fresh')]);
  await expect(stale).resolves.toBeUndefined();
  expect((await fresh).suggestions.map((item: { label: string }) => item.label)).toEqual(['fresh']);
  await settle();
  expect(group.cacheSize).toBe(1);
  expect(features.commandCount).toBe(0);
});

test('a list that arrives after the workbench cancelled is released at once', async () => {
  const { languages, group } = await setup();
  const source = new CancellationTokenSource();
  languages().registerCompletionItemProvider('lftest', {
    provideCompletionItems: () => {
      // The workbench gives up while the answer is on its way: the extension host has not heard yet and keeps the list.
      source.cancel();
      return [new CompletionItem('one')];
    },
  });
  await settle();
  await expect(complete(undefined, invoke, source.token)).resolves.toBeUndefined();
  await settle();
  expect(group.cacheSize).toBe(0);
});

test('the extension\'s release forgets its lists', async () => {
  const { languages, group, features } = await setup();
  languages('1').registerCompletionItemProvider('lftest', { provideCompletionItems: () => [new CompletionItem('one')] });
  languages('2').registerCompletionItemProvider('lftest', { provideCompletionItems: () => [new CompletionItem('two')] });
  await settle();
  await complete(undefined, invoke, token(), 0);
  await complete(undefined, invoke, token(), 1);
  expect(group.cacheSize).toBe(2);
  features.release('1');
  group.release('1');
  expect(group.cacheSize).toBe(1);
});

test('the workbench keeps ranges on the position\'s line, Monaco\'s kinds and rules only', async () => {
  const { languages } = await setup();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  languages().registerCompletionItemProvider('lftest', {
    provideCompletionItems: () => {
      const offLine = new CompletionItem('offLine');
      offLine.range = new Range(1, 0, 1, 2);
      return [offLine, new CompletionItem('kept')];
    },
  });
  await settle();
  const list = await complete();
  // The extension host drops an item Monaco could not place.
  expect(list.suggestions.map((item: { label: string }) => item.label)).toEqual(['kept']);
  // It says so once per provider, not on every request.
  await complete();
  expect(warn).toHaveBeenCalledTimes(1);
  // What the host sends is checked again.
  const main = host!.workbench.groups[0] as unknown as { toCompletionList: (...args: unknown[]) => { suggestions: Record<string, unknown>[] } };
  const checked = main.toCompletionList(host!.monaco, {
    id: 1, defaults: { insert: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 9 }, replace: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 11 } },
    items: [
      { index: 0, label: 'a', kind: 77, insertText: 'a', insertTextRules: 0xff, range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 } },
      { index: 1, label: 3, kind: 1, insertText: 'b' },
      { index: 2, label: 'c', kind: 1, insertText: 'c', documentation: { value: 'd', isTrusted: 'yes', supportHtml: 1, extra: true } },
    ],
  }, { lineNumber: 1, column: 9 });
  expect(checked.suggestions).toHaveLength(2);
  expect(checked.suggestions[0]).toMatchObject({ kind: 9, insertTextRules: 5, range: { insert: { endColumn: 9 }, replace: { endColumn: 11 } } });
  expect(checked.suggestions[1].documentation).toEqual({ value: 'd' });
});

test('hover: marked strings and markdown cross with their trust as given, the range defaults to the word, every provider answers', async () => {
  const { languages } = await setup();
  const trusted = new MarkdownString('[run](command:fixture.run) <b>bold</b>');
  trusted.isTrusted = true;
  trusted.supportHtml = true;
  trusted.baseUri = Uri.parse('vscode-vfs://writing-room/workspace/docs/');
  languages('1').registerHoverProvider('lftest', {
    provideHover: () => new Hover(['plain **text**', { language: 'js', value: 'let x = 1;' }, trusted]),
  });
  languages('2').registerHoverProvider('lftest', {
    provideHover: () => new Hover(new MarkdownString('[run](command:fixture.run)<script>alert(1)</script>'), new Range(1, 0, 1, 4)),
  });
  await settle();
  const providers = host!.of('HoverProvider').map(entry => entry.provider);
  expect(providers).toHaveLength(2);
  const [first, second] = await Promise.all(providers.map(provider => provider.provideHover(model(), { lineNumber: 1, column: 3 }, token())));
  expect(first.contents).toEqual([
    { value: 'plain **text**' },
    { value: '\n```js\nlet x = 1;\n```\n' },
    { value: '[run](command:fixture.run) <b>bold</b>', isTrusted: true, supportHtml: true, baseUri: { scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace/docs/', query: '', fragment: '' } },
  ]);
  expect(first.range).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 });
  // Untrusted stays untrusted and without HTML: Monaco leaves its command links dead and its HTML as text.
  expect(second.contents).toEqual([{ value: '[run](command:fixture.run)<script>alert(1)</script>' }]);
  expect(second.range).toEqual({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 });
});

test('hover markdown from the extension host is trusted only when it says so in Monaco\'s terms', () => {
  expect(checkMarkdown({ value: 'x', isTrusted: 'true', supportHtml: 'yes', supportThemeIcons: 1 })).toEqual({ value: 'x' });
  expect(checkMarkdown({ value: 'x', isTrusted: { enabledCommands: ['fixture.ok', 3] } })).toEqual({ value: 'x', isTrusted: { enabledCommands: ['fixture.ok'] } });
  expect(checkMarkdown({ value: 3 })).toBeUndefined();
  expect(toHover({ contents: [{ value: 1 }] } as never)).toBeUndefined();
  expect(toHover({ contents: [{ value: 'a' }], range: { startLineNumber: 3, startColumn: 1, endLineNumber: 2, endColumn: 1 } })).toEqual({ contents: [{ value: 'a' }] });
});

test('signature help: the active signature and parameter cross, the trigger characters reach Monaco, the context comes back', async () => {
  const { languages } = await setup();
  const provide = vi.fn((_document: vscode.TextDocument, _position: vscode.Position, _token: vscode.CancellationToken, context: vscode.SignatureHelpContext) => {
    const help = new SignatureHelp();
    const signature = new SignatureInformation('call(first, second)', new MarkdownString('Calls.'));
    signature.parameters = [new ParameterInformation([5, 10], 'The first.'), new ParameterInformation('second')];
    help.signatures = [new SignatureInformation('call()'), signature];
    help.activeSignature = 1;
    help.activeParameter = context.isRetrigger ? 1 : 0;
    return help;
  });
  languages().registerSignatureHelpProvider('lftest', { provideSignatureHelp: provide }, { triggerCharacters: ['('], retriggerCharacters: [','] });
  languages().registerSignatureHelpProvider('lftest', { provideSignatureHelp: () => undefined }, '(', '<');
  await settle();
  const [first, second] = host!.of('SignatureHelpProvider').map(entry => entry.provider);
  expect([first.signatureHelpTriggerCharacters, first.signatureHelpRetriggerCharacters]).toEqual([['('], [',']]);
  expect([second.signatureHelpTriggerCharacters, second.signatureHelpRetriggerCharacters]).toEqual([['(', '<'], []]);
  const result = await first.provideSignatureHelp(model(), { lineNumber: 2, column: 6 }, token(), { triggerKind: 2, triggerCharacter: '(', isRetrigger: false });
  expect(result.value).toEqual({
    activeSignature: 1, activeParameter: 0,
    signatures: [
      { label: 'call()', parameters: [] },
      { label: 'call(first, second)', documentation: { value: 'Calls.' }, parameters: [{ label: [5, 10], documentation: 'The first.' }, { label: 'second' }] },
    ],
  });
  const again = await first.provideSignatureHelp(model(), { lineNumber: 2, column: 11 }, token(),
    { triggerKind: 3, isRetrigger: true, activeSignatureHelp: result.value });
  expect(again.value.activeParameter).toBe(1);
  const context = provide.mock.calls[1][3];
  expect(context).toMatchObject({ triggerKind: SignatureHelpTriggerKind.ContentChange, isRetrigger: true, triggerCharacter: undefined });
  expect(context.activeSignatureHelp).toBeInstanceOf(SignatureHelp);
  expect(context.activeSignatureHelp!.signatures[1].parameters[0].label).toEqual([5, 10]);
  expect((context.activeSignatureHelp!.signatures[1].documentation as vscode.MarkdownString).value).toBe('Calls.');
  await expect(second.provideSignatureHelp(model(), { lineNumber: 2, column: 6 }, token(), { triggerKind: 1, isRetrigger: false })).resolves.toBeUndefined();
});

test('signature help from the extension host is checked: the active signature exists, offsets lie in the label', () => {
  expect(toSignatureHelp({ signatures: [{ label: 'f(a)', parameters: [{ label: [2, 99] }, { label: [2, 3] }] }], activeSignature: 5, activeParameter: -1 })).toEqual({
    signatures: [{ label: 'f(a)', parameters: [{ label: [0, 0] }, { label: [2, 3] }] }], activeSignature: 0, activeParameter: 0,
  });
  expect(toSignatureHelp({ signatures: [], activeSignature: 0, activeParameter: 0 })).toBeUndefined();
});

test('the API classes can be extended as a language client does, and providers are checked when registered', async () => {
  class ProtocolCompletionItem extends CompletionItem {
    data = 'kept';
  }
  const item = new ProtocolCompletionItem({ label: 'x' }, CompletionItemKind.Text);
  expect([item.label, item.kind, item.data]).toEqual([{ label: 'x' }, 0, 'kept']);
  expect(new CompletionList().items).toEqual([]);
  expect(new SignatureInformation('f').parameters).toEqual([]);
  expect(() => new Hover(undefined as never)).toThrow();
  const { languages } = await setup();
  expect(() => languages().registerCompletionItemProvider('lftest', {} as never)).toThrow(TypeError);
  expect(() => languages().registerHoverProvider(7 as never, { provideHover: () => undefined })).toThrow(TypeError);
});

test('a document the extension may not read, or a broken position, answers nothing without calling the provider', async () => {
  const { languages } = await setup();
  const provideHover = vi.fn(() => new Hover('x'));
  languages().registerHoverProvider('*', { provideHover });
  await settle();
  const [provider] = host!.of('HoverProvider').map(entry => entry.provider);
  const other = testModel(workspaceUri('missing.lft'), 'x') as IMonacoTextModel;
  await expect(provider.provideHover(other, { lineNumber: 1, column: 1 }, token())).resolves.toBeUndefined();
  await expect(provider.provideHover(model(), { lineNumber: 0, column: 1 }, token() as CancellationToken)).resolves.toBeUndefined();
  expect(provideHover).not.toHaveBeenCalled();
});
