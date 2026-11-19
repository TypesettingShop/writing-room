// @vitest-environment node
import { afterEach, expect, test } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { MonacoNamespace } from '../../../../../editor/browser/monaco.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import type { IModelLanguageChangedEvent, IModelService } from '../../../../../editor/common/services/model.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../../platform/extensions/common/extensions.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { ExtensionMessageCollector, ExtensionsRegistry } from '../../../../services/extensions/common/extensionsRegistry.js';
import type { ExtensionPointContext } from '../../../../services/extensions/common/extensionsRegistry.js';
import { createSnippetCompletionProvider } from '../../browser/snippetCompletionProvider.js';
import { SnippetsContribution } from '../../browser/snippets.contribution.js';
import { MAX_SNIPPETS_PER_FILE, parseSnippetFile } from '../../browser/snippetsFile.js';
import { snippetContributions, SnippetsService } from '../../browser/snippetsService.js';

const flush = async (times = 3) => {
  for (let i = 0; i < times; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

test('parses prefixes and bodies as strings or arrays, and drops only entries of another shape', () => {
  const messages: string[] = [];
  const snippets = parseSnippetFile(`{
    // A comment, and a trailing comma below.
    "Bold": { "prefix": "bold", "body": "**$1**", "description": "Insert bold text" },
    "Fence": { "prefix": ["fence", "code"], "body": ["\`\`\`", "$0", "\`\`\`"] },
    "No prefix": { "body": "x" },
    "Numeric prefix": { "prefix": 42, "body": "x" },
    "No body": { "prefix": "nb" },
    "Not an object": 3,
  }`, message => messages.push(message));
  expect(snippets).toEqual([
    { name: 'Bold', prefix: 'bold', body: '**$1**', description: 'Insert bold text' },
    { name: 'Fence', prefix: 'fence', body: '```\n$0\n```', description: undefined },
    { name: 'Fence', prefix: 'code', body: '```\n$0\n```', description: undefined },
  ]);
  expect(messages).toHaveLength(4);
});

test('a file that is not JSON gives nothing and one message, and a file is read up to its snippet limit', () => {
  const messages: string[] = [];
  expect(parseSnippetFile('{ "a": ', message => messages.push(message))).toEqual([]);
  expect(messages).toEqual(['is not valid JSON.']);

  const many = Object.fromEntries(Array.from({ length: MAX_SNIPPETS_PER_FILE + 2 }, (_, i) => [`s${i}`, { prefix: `p${i}`, body: 'b' }]));
  const limited: string[] = [];
  expect(parseSnippetFile(JSON.stringify(many), message => limited.push(message))).toHaveLength(MAX_SNIPPETS_PER_FILE);
  expect(limited).toHaveLength(1);
});

const point = ExtensionsRegistry.getExtensionPoints().find(candidate => candidate.name === 'snippets')!;
const messages: IExtensionMessage[] = [];
let contributions = new DisposableStore();
function contribute(extensions: { id: string; displayName?: string; snippets: unknown }[]): void {
  contributions.dispose();
  contributions = new DisposableStore();
  messages.length = 0;
  point.accept(extensions.map(extension => ({
    description: {
      identifier: new ExtensionIdentifier(extension.id),
      location: `http://127.0.0.1:9/${extension.id}/`,
      manifest: { name: extension.id.split('.')[1], displayName: extension.displayName },
    } as IExtensionDescription,
    value: extension.snippets,
    collector: new ExtensionMessageCollector(extension.id, message => messages.push(message)),
  })), contributions, {} as ExtensionPointContext);
}

function fakeFiles(contents: Record<string, string>) {
  const reads: string[] = [];
  const files = {
    readFile: async (resource: URI, options?: { limits?: { size?: number } }) => {
      reads.push(resource.toString());
      expect(options?.limits?.size).toBe(8 * 1024 * 1024);
      const text = contents[resource.toString()];
      if (text === undefined) {
        throw new Error('Not found');
      }
      return { value: new TextEncoder().encode(text) };
    },
  } as unknown as IFileService;
  return { files, reads };
}

const bold = '{ "Insert bold text": { "prefix": "bold", "body": "**${1:${TM_SELECTED_TEXT}}**$0", "description": "Insert bold text" } }';

afterEach(async () => {
  contributions.dispose();
  await flush();
});

test('resolves snippet files inside the extension and refuses a path that leaves it', () => {
  contribute([{ id: 'fixtures.md', displayName: 'Markdown Fixture', snippets: [
    { language: 'markdown', path: './snippets/markdown.code-snippets' },
    { language: 'markdown', path: '../other/markdown.code-snippets' },
    { language: 3, path: './x.json' },
  ] }]);
  expect(snippetContributions.current.map(({ language, location, source }) => [language, location.toString(), source])).toEqual([
    ['markdown', 'http://127.0.0.1:9/fixtures.md/snippets/markdown.code-snippets', 'Markdown Fixture'],
  ]);
  expect(messages.map(message => [message.severity, message.path])).toEqual([
    ['warn', 'contributes.snippets[1].path'], ['error', 'contributes.snippets[2].language'],
  ]);
});

test('reads a language\'s files once, when asked, and a broken one does not hide the others', async () => {
  contribute([
    { id: 'fixtures.broken', snippets: [{ language: 'markdown', path: './broken.json' }] },
    { id: 'fixtures.md', displayName: 'Markdown Fixture', snippets: [{ language: 'markdown', path: './s.json' }] },
  ]);
  const { files, reads } = fakeFiles({
    'http://127.0.0.1:9/fixtures.broken/broken.json': '{ "a": ',
    'http://127.0.0.1:9/fixtures.md/s.json': bold,
  });
  const service = new SnippetsService(files);
  expect(reads).toEqual([]);
  expect((await service.getSnippets('markdown')).map(snippet => [snippet.prefix, snippet.source])).toEqual([['bold', 'Markdown Fixture']]);
  expect(await service.getSnippets('plaintext')).toEqual([]);
  await service.getSnippets('markdown');
  expect(reads).toHaveLength(2);
});

class FakeModelService {
  private readonly added = new Emitter<ITextModel>();
  readonly onModelAdded = this.added.event;
  readonly onModelRemoved = new Emitter<ITextModel>().event;
  readonly onModelLanguageChanged = new Emitter<IModelLanguageChangedEvent>().event;
  getModels(): ITextModel[] { return []; }
  add(language: string): void {
    this.added.fire({ getLanguageId: () => language, uri: URI.parse('untitled:x') } as unknown as ITextModel);
  }
}

const fakeMonaco = () => {
  const providers: { languageId: string; disposed: boolean }[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Snippet: 27 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (languageId: string) => {
        const entry = { languageId, disposed: false };
        providers.push(entry);
        return toDisposable(() => entry.disposed = true);
      },
    },
  } as unknown as MonacoNamespace;
  return { monaco, live: () => providers.filter(entry => !entry.disposed).map(entry => entry.languageId) };
};

test('registers a completion provider only for languages with snippets, and removes it with the extension', async () => {
  const { monaco, live } = fakeMonaco();
  const models = new FakeModelService();
  class TestContribution extends SnippetsContribution {
    protected override loadMonaco(): Promise<MonacoNamespace> { return Promise.resolve(monaco); }
  }
  const contribution = new TestContribution(models as unknown as IModelService, fakeFiles({}).files);
  try {
    contribute([{ id: 'fixtures.md', snippets: [{ language: 'markdown', path: './s.json' }] }]);
    models.add('plaintext');
    models.add('markdown');
    await flush();
    expect(live()).toEqual(['markdown']);

    contribute([{ id: 'fixtures.md', snippets: [{ language: 'markdown', path: './s.json' }] }]);
    await flush();
    expect(live()).toEqual(['markdown']);

    contributions.dispose();
    await flush();
    expect(live()).toEqual([]);
  } finally {
    contribution.dispose();
  }
});

test('completion items are snippets over the word before the cursor, with their source in the detail', async () => {
  contribute([{ id: 'fixtures.md', displayName: 'Markdown Fixture', snippets: [{ language: 'markdown', path: './s.json' }] }]);
  const { monaco } = fakeMonaco();
  const provider = createSnippetCompletionProvider(monaco,
    new SnippetsService(fakeFiles({ 'http://127.0.0.1:9/fixtures.md/s.json': bold }).files), 'markdown');
  const model = { isDisposed: () => false, getWordUntilPosition: () => ({ word: 'bo', startColumn: 3, endColumn: 5 }) };
  const list = await provider.provideCompletionItems(model as never, { lineNumber: 1, column: 5 } as never, {} as never,
    { isCancellationRequested: false } as never);
  expect(list?.suggestions).toEqual([expect.objectContaining({
    label: { label: 'bold', description: 'Insert bold text' },
    detail: 'Insert bold text (Markdown Fixture)',
    insertText: '**${1:${TM_SELECTED_TEXT}}**$0',
    insertTextRules: 4,
    kind: 27,
    range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 5 },
  })]);
});
