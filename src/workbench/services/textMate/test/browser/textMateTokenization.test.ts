// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import * as textMate from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { MonacoNamespace } from '../../../../../editor/browser/monaco.js';
import type { ILanguageService } from '../../../../../editor/common/languages/language.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import type { IModelLanguageChangedEvent, IModelService } from '../../../../../editor/common/services/model.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../../platform/extensions/common/extensions.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { ColorScheme } from '../../../../../platform/theme/common/themeService.js';
import type { IColorTheme, IThemeService, ITokenColorizationRule } from '../../../../../platform/theme/common/themeService.js';
import { ExtensionMessageCollector, ExtensionsRegistry } from '../../../extensions/common/extensionsRegistry.js';
import type { ExtensionPointContext } from '../../../extensions/common/extensionsRegistry.js';
import type { ITextMateRuntime } from '../../browser/textMateRuntime.js';
import {
  MAX_TOKENIZATION_LINE_LENGTH, readMonacoColorMap, TextMateTokenizationFeature, TextMateTokensProvider,
} from '../../browser/textMateTokenizationFeatureImpl.js';
import { grammarContributions } from '../../common/TMGrammars.js';

const root = new URL('../../../../../../', import.meta.url);
const fixtureRoot = new URL('test/fixtures/extensions/language-basics/', root);
const flush = async (times = 3) => {
  for (let i = 0; i < times; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

let wasm: Promise<void> | undefined;
async function nodeRuntime(): Promise<ITextMateRuntime> {
  wasm ??= oniguruma.loadWASM(readFileSync(new URL('node_modules/vscode-oniguruma/release/onig.wasm', root)).buffer as ArrayBuffer);
  await wasm;
  return {
    textMate,
    onigLib: { createOnigScanner: sources => new oniguruma.OnigScanner(sources), createOnigString: text => new oniguruma.OnigString(text) },
  };
}

const grammarPoint = ExtensionsRegistry.getExtensionPoints().find(point => point.name === 'grammars')!;
const messages: IExtensionMessage[] = [];
let contributions = new DisposableStore();
function contribute(grammars: unknown, location = fixtureRoot.href): void {
  contributions.dispose();
  contributions = new DisposableStore();
  messages.length = 0;
  grammarPoint.accept([{
    description: { identifier: new ExtensionIdentifier('fixtures.language-basics'), location } as IExtensionDescription,
    value: grammars,
    collector: new ExtensionMessageCollector('fixtures.language-basics', message => messages.push(message)),
  }], contributions, {} as ExtensionPointContext);
}

const fixturelangGrammar = [{ language: 'fixturelang', scopeName: 'source.fixturelang', path: './syntaxes/fixturelang.tmLanguage.json' }];

function theme(rules: ITokenColorizationRule[]): IColorTheme {
  return {
    id: 'test', label: 'Test', type: ColorScheme.DARK, tokenColors: rules, semanticHighlighting: false,
    getColor: id => ({ 'editor.foreground': '#d4d4d4', 'editor.background': '#1e1e1e' } as Record<string, string>)[id],
    defines: () => false,
  };
}

class FakeMonaco {
  readonly providers = new Map<string, { provider: TextMateTokensProvider; disposed: boolean }[]>();
  colorMap: string[] | null = null;
  readonly colorMaps: (string[] | null)[] = [];
  readonly languages = {
    getLanguages: () => [{ id: 'plaintext' }, { id: 'fixturelang' }],
    getEncodedLanguageId: (id: string) => ({ plaintext: 1, fixturelang: 7 } as Record<string, number>)[id] ?? 9,
    setColorMap: (map: string[] | null) => { this.colorMap = map; this.colorMaps.push(map); },
    setTokensProvider: (languageId: string, provider: TextMateTokensProvider) => {
      const entry = { provider, disposed: false };
      this.providers.set(languageId, [...this.providers.get(languageId) ?? [], entry]);
      return toDisposable(() => entry.disposed = true);
    },
    setMonarchTokensProvider: () => toDisposable(() => {}),
  };
  readonly editor = { colorize: async () => '' };
  live(languageId: string): TextMateTokensProvider | undefined {
    return this.providers.get(languageId)?.filter(entry => !entry.disposed).at(-1)?.provider;
  }
}

/** Monaco's `vs-dark` color map as its style element writes it. */
const monacoStyle = { textContent: '.mtk1 { color: #d4d4d4; }\n.mtk2 { color: #1e1e1e; }\n.mtk3 { color: rgba(255, 0, 0, 0.5); }' };

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

const disposables = new DisposableStore();
afterEach(async () => {
  disposables.clear();
  contributions.dispose();
  await flush();
});

function createFeature(initialTheme: IColorTheme, options: { runtime?: () => Promise<ITextMateRuntime> } = {}) {
  const monaco = new FakeMonaco();
  const models = new FakeModelService();
  const themeChanged = new Emitter<IColorTheme>();
  let current = initialTheme;
  const themes = { getColorTheme: () => current, onDidColorThemeChange: themeChanged.event } as unknown as IThemeService;
  const reads: string[] = [];
  const files = {
    readFile: async (resource: URI, options?: { limits?: { size?: number } }) => {
      reads.push(resource.toString());
      expect(options?.limits?.size).toBe(8 * 1024 * 1024);
      return { value: readFileSync(new URL(resource.toString())) };
    },
  } as unknown as IFileService;
  const languages = { isRegisteredLanguageId: (id: string) => id === 'fixturelang' || id === 'plaintext' } as unknown as ILanguageService;
  let runtimeLoads = 0;
  class TestFeature extends TextMateTokenizationFeature {
    protected override loadMonaco(): Promise<MonacoNamespace> { return Promise.resolve(monaco as unknown as MonacoNamespace); }
    protected override loadRuntime(): Promise<ITextMateRuntime> {
      runtimeLoads++;
      return (options.runtime ?? nodeRuntime)();
    }
    protected override get document(): Document {
      return { querySelector: () => monacoStyle } as unknown as Document;
    }
  }
  const feature = disposables.add(new TestFeature(models as unknown as IModelService, languages, files, themes));
  return {
    feature, monaco, models, reads,
    get runtimeLoads() { return runtimeLoads; },
    setTheme: (next: IColorTheme) => { current = next; themeChanged.fire(next); },
  };
}

/** The foreground color of each token `provider` gives `line`, through the color map Monaco got. */
function foregrounds(monaco: FakeMonaco, provider: TextMateTokensProvider, line: string): string[] {
  const { tokens } = provider.tokenizeEncoded(line, provider.getInitialState());
  const colors: string[] = [];
  for (let i = 1; i < tokens.length; i += 2) {
    colors.push(monaco.colorMap![(tokens[i] >>> 15) & 0x1ff]);
  }
  return colors;
}

const keywordRules = (color: string): ITokenColorizationRule[] => [
  { settings: { foreground: '#d7dfec' } },
  { scope: 'keyword', settings: { foreground: color } },
];

test('loads nothing until a language with a grammar is used, then colors it with the theme', async () => {
  contribute(fixturelangGrammar);
  const setup = createFeature(theme(keywordRules('#569cd6')));
  setup.models.add('plaintext');
  await flush();
  expect(setup.runtimeLoads).toBe(0);
  expect(setup.reads).toEqual([]);

  setup.models.add('fixturelang');
  await flush(10);
  expect(setup.runtimeLoads).toBe(1);
  expect(setup.reads).toEqual([new URL('syntaxes/fixturelang.tmLanguage.json', fixtureRoot).href]);
  const provider = setup.monaco.live('fixturelang')!;
  expect(foregrounds(setup.monaco, provider, 'alpha x')).toEqual(['#569CD6', '#D7DFEC']);
  // Monaco's own colors come first, so its built-in tokenizers keep their color numbers.
  expect(setup.monaco.colorMap!.slice(0, 4)).toEqual(['', '#D4D4D4', '#1E1E1E', '#FF000080']);
});

test('a theme change recolors without reloading', async () => {
  contribute(fixturelangGrammar);
  const setup = createFeature(theme(keywordRules('#569cd6')));
  setup.models.add('fixturelang');
  await flush(10);
  const provider = setup.monaco.live('fixturelang')!;
  expect(foregrounds(setup.monaco, provider, 'alpha')).toEqual(['#569CD6']);

  setup.setTheme(theme(keywordRules('#ff8800')));
  await flush();
  expect(foregrounds(setup.monaco, provider, 'alpha')).toEqual(['#FF8800']);
  expect(setup.runtimeLoads).toBe(1);
});

test('does not tokenize a line of 20,000 characters or more, and keeps the state of a line that ran out of time', async () => {
  contribute(fixturelangGrammar);
  const setup = createFeature(theme(keywordRules('#569cd6')));
  setup.models.add('fixturelang');
  await flush(10);
  const provider = setup.monaco.live('fixturelang')!;
  const initial = provider.getInitialState();
  const long = provider.tokenizeEncoded('alpha '.repeat(MAX_TOKENIZATION_LINE_LENGTH / 6 + 1), initial);
  expect(long.tokens.length).toBe(2);
  expect(long.endState).toBe(initial);
  expect(long.tokens[1] & 0xff).toBe(7);

  const opened = provider.tokenizeEncoded('"open string', initial);
  expect(opened.endState).not.toBe(initial);
  const grammar = { tokenizeLine2: () => ({ tokens: new Uint32Array([0, 1]), ruleStack: opened.endState, stoppedEarly: true }) };
  const slow = new TextMateTokensProvider(grammar as never, initial, 7, 'fixturelang', 1);
  expect(slow.tokenizeEncoded('x', initial).endState).toBe(initial);
});

test('a grammar that leaves the extension folder is refused and never read', async () => {
  contribute([{ language: 'fixturelang', scopeName: 'source.fixturelang', path: '../language-basics/syntaxes/fixturelang.tmLanguage.json' }],
    new URL('broken/', fixtureRoot).href);
  expect(grammarContributions.current).toEqual([]);
  expect(messages).toEqual([expect.objectContaining({ severity: 'warn', path: 'contributes.grammars[0].path' })]);
  const setup = createFeature(theme(keywordRules('#569cd6')));
  setup.models.add('fixturelang');
  await flush(10);
  expect(setup.reads).toEqual([]);
  expect(setup.runtimeLoads).toBe(0);
});

test('when the engine cannot load, the language keeps its built-in tokenizer and the editor is unharmed', async () => {
  contribute(fixturelangGrammar);
  const setup = createFeature(theme(keywordRules('#569cd6')), { runtime: () => Promise.reject(new Error('no wasm')) });
  setup.models.add('fixturelang');
  await flush(10);
  expect(setup.monaco.live('fixturelang')).toBeUndefined();
  expect(setup.monaco.colorMaps).toEqual([]);
});

test('removing the grammar releases the tokenizer and Monaco\'s own colors come back', async () => {
  contribute(fixturelangGrammar);
  const setup = createFeature(theme(keywordRules('#569cd6')));
  setup.models.add('fixturelang');
  await flush(10);
  expect(setup.monaco.live('fixturelang')).toBeDefined();

  contribute(fixturelangGrammar);
  await flush(10);
  expect(setup.monaco.providers.get('fixturelang')).toHaveLength(1);

  contributions.dispose();
  await flush(10);
  expect(setup.monaco.live('fixturelang')).toBeUndefined();
  expect(setup.monaco.colorMap).toBeNull();
});

test('embedded languages that are not registered stay in the outer language', async () => {
  contribute([{
    language: 'fixturelang', scopeName: 'source.fixturelang', path: './syntaxes/fixturelang.tmLanguage.json',
    embeddedLanguages: { 'string.quoted.double.fixturelang': 'plaintext', 'comment.line.percentage.fixturelang': 'nowhere' },
  }]);
  const setup = createFeature(theme(keywordRules('#569cd6')));
  setup.models.add('fixturelang');
  await flush(10);
  const provider = setup.monaco.live('fixturelang')!;
  const { tokens } = provider.tokenizeEncoded('alpha "s" %% c', provider.getInitialState());
  const languages = [];
  for (let i = 1; i < tokens.length; i += 2) {
    languages.push(tokens[i] & 0xff);
  }
  // `alpha`, a space, the string (plain text), a space, the comment (its language is unknown).
  expect(languages).toEqual([7, 7, 1, 7, 7]);
});

test('reads Monaco\'s color map from its style rules, in hex and rgba', () => {
  const monaco = { editor: { colorize: async () => '' } } as unknown as MonacoNamespace;
  expect(readMonacoColorMap(monaco, { querySelector: () => monacoStyle } as unknown as Document))
    .toEqual(['', '#D4D4D4', '#1E1E1E', '#FF000080']);
  expect(readMonacoColorMap(monaco, { querySelector: () => null } as unknown as Document)).toBeUndefined();
});
