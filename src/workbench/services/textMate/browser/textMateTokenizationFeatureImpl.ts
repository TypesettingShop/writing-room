import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { loadMonaco } from '../../../../editor/browser/monaco.js';
import type { MonacoNamespace } from '../../../../editor/browser/monaco.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { extensionResourceLimits } from '../../extensions/common/extensionResources.js';
import { waitForBuiltinLanguage } from '../../language/browser/monacoLanguages.js';
import { watchRequestedLanguages } from '../../language/common/requestedLanguages.js';
import { grammarContributions, grammarsSignature } from '../common/TMGrammars.js';
import type { IContributedGrammar } from '../common/TMGrammars.js';
import type { ITextMateRuntime } from './textMateRuntime.js';
import type { IGrammar, IRawGrammar, IRawTheme, Registry, StateStack } from 'vscode-textmate';

type Monaco = MonacoNamespace;
type IEncodedTokensProvider = Parameters<Monaco['languages']['setTokensProvider']>[1] & { tokenizeEncoded: unknown };

/** Lines this long or longer are not tokenized (`editor.maxTokenizationLineLength`). */
export const MAX_TOKENIZATION_LINE_LENGTH = 20_000;
/** A line's tokenization stops after this long; the rest of the line keeps the default color. */
export const TOKENIZATION_TIME_LIMIT = 500;

// VS Code's token metadata: language 8 bits, token type 2, balanced brackets 1, font style 4, colors 9 and 8.
const FOREGROUND_OFFSET = 15;
const BACKGROUND_OFFSET = 24;
const DEFAULT_FOREGROUND = 1;
const DEFAULT_BACKGROUND = 2;

/** The one token of a line that is not tokenized: the language's default colors. */
function untokenizedLine(encodedLanguageId: number): Uint32Array {
  return new Uint32Array([0, (encodedLanguageId | (DEFAULT_FOREGROUND << FOREGROUND_OFFSET) | (DEFAULT_BACKGROUND << BACKGROUND_OFFSET)) >>> 0]);
}

/**
 * A grammar as Monaco's encoded tokens provider, with VS Code's limits: a line of 20,000 characters or
 * more keeps the default color, and a line whose tokenization runs out of time keeps the state it started
 * with, so the next line starts from somewhere sound.
 */
export class TextMateTokensProvider {
  private warnedTimeLimit = false;

  constructor(
    private readonly grammar: IGrammar,
    private readonly initialState: StateStack,
    private readonly encodedLanguageId: number,
    private readonly languageId: string,
    private readonly timeLimit = TOKENIZATION_TIME_LIMIT,
  ) {}

  getInitialState(): StateStack {
    return this.initialState;
  }

  tokenizeEncoded(line: string, state: StateStack): { tokens: Uint32Array; endState: StateStack } {
    if (line.length >= MAX_TOKENIZATION_LINE_LENGTH) {
      return { tokens: untokenizedLine(this.encodedLanguageId), endState: state };
    }
    const result = this.grammar.tokenizeLine2(line, state, this.timeLimit);
    if (result.stoppedEarly) {
      if (!this.warnedTimeLimit) {
        this.warnedTimeLimit = true;
        console.warn(`[${this.languageId}] Time limit reached when tokenizing a line of ${line.length} characters; the rest of it is not colored.`);
      }
      return { tokens: result.tokens, endState: state };
    }
    return { tokens: result.tokens, endState: result.ruleStack };
  }
}

/** Monaco's token color map, as it writes it into its `.mtkN` rules: index N is color N, as `#RRGGBB(AA)`. */
export function readMonacoColorMap(monaco: Monaco, document: Document): string[] | undefined {
  // Monaco creates its style element with the first editor or colorization; this makes sure it exists.
  void monaco.editor.colorize('', 'plaintext', {});
  const css = document.querySelector('style.monaco-colors')?.textContent;
  if (!css) {
    return undefined;
  }
  const colors: string[] = [''];
  for (const [, index, color] of css.matchAll(/\.mtk(\d+) \{ color: ([^;]+); \}/g)) {
    const normalized = normalizeColor(color);
    if (!normalized) {
      return undefined;
    }
    colors[Number(index)] = normalized;
  }
  return colors.length > 1 && !colors.slice(1).includes(undefined as unknown as string) ? colors : undefined;
}

function normalizeColor(color: string): string | undefined {
  const value = color.trim();
  if (/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) {
    return value.toUpperCase();
  }
  const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value);
  if (!rgba) {
    return undefined;
  }
  const hex = (part: number) => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, '0');
  const alpha = rgba[4] === undefined ? '' : hex(Number(rgba[4]) * 255);
  return ('#' + hex(Number(rgba[1])) + hex(Number(rgba[2])) + hex(Number(rgba[3])) + alpha).toUpperCase();
}

/** A color theme's token colors as a TextMate theme; a theme without default rule gets the editor's colors. */
export function toRawTheme(theme: IColorTheme): IRawTheme {
  const settings = theme.tokenColors.map(rule => ({
    name: rule.name,
    scope: typeof rule.scope === 'string' ? rule.scope : rule.scope ? [...rule.scope] : undefined,
    settings: { ...rule.settings },
  }));
  if (!settings.length || settings[0].scope !== undefined) {
    settings.unshift({
      name: undefined, scope: undefined,
      settings: { foreground: theme.getColor('editor.foreground'), background: theme.getColor('editor.background') },
    });
  }
  return { name: theme.id, settings };
}

export const ITextMateTokenizationService = createDecorator<ITextMateTokenizationService>('textMateTokenizationService');

export interface ITextMateTokenizationService extends BrandedService {
  /**
   * The scopes TextMate gives each token of one `line` of `languageId`, starting from the initial state;
   * `null` when no grammar of the language is in use or it cannot be loaded. Tests ask it.
   */
  tokenizeLine(languageId: string, line: string): Promise<{ text: string; scopes: string[] }[] | null>;
}

interface ITokenizer {
  /** The grammars signature it was made under: equal contributions give equal signatures, not equal objects. */
  readonly signature: string;
  readonly registration: IDisposable;
}

let runtimeLoad: Promise<ITextMateRuntime> | undefined;
function loadRuntime(): Promise<ITextMateRuntime> {
  runtimeLoad ??= import('./textMateRuntime.js').then(module => module.loadTextMateRuntime()).catch(error => {
    runtimeLoad = undefined;
    throw error;
  });
  return runtimeLoad;
}

/**
 * Colors languages with the TextMate grammars extensions contribute, as VS Code's
 * `TextMateTokenizationFeature` does, on the main thread (VS Code can move it to a worker).
 *
 * - Nothing is loaded before a language with a grammar is used: then the engine, its WebAssembly and the
 *   grammar files come, read through the file service, inside the extension, at most 8 MiB each.
 * - Tokens are encoded with the theme's token colors. Monaco has one token color map for every language,
 *   and its built-in tokenizers number their colors in its theme's map, so the map Monaco gets is its own
 *   with the grammar theme's colors added after it.
 * - When the engine, the WebAssembly or a grammar cannot be loaded, the language keeps Monaco's built-in
 *   tokenizer, or no colors, and a warning says why. When an extension goes, its grammars go with it and
 *   a built-in language gets its built-in tokenizer back.
 */
export class TextMateTokenizationFeature extends Disposable implements ITextMateTokenizationService {
  declare readonly _serviceBrand: undefined;

  private monaco: Monaco | undefined;
  private registry: { readonly registry: Registry; readonly signature: string; readonly runtime: ITextMateRuntime } | undefined;
  private signature = grammarsSignature(grammarContributions.current);
  private readonly requested = new Set<string>();
  private readonly tokenizers = new Map<string, ITokenizer>();
  private readonly restored = new Map<string, IDisposable>();
  private readonly attaching = new Map<string, number>();
  private generation = 0;
  private colorMapApplied = false;
  private warnedRuntime = false;
  private readonly warnedGrammars = new Set<string>();
  /** Scopes whose grammar file could not be read or parsed; a warning already said why. */
  private readonly failedScopes = new Set<string>();

  constructor(
    @IModelService modelService: IModelService,
    @ILanguageService private readonly languageService: ILanguageService,
    @IFileService private readonly fileService: IFileService,
    @IThemeService private readonly themeService: IThemeService,
  ) {
    super();
    this._register(grammarContributions.onDidChange(() => this.grammarsChanged()));
    this._register(themeService.onDidColorThemeChange(() => {
      // Whoever gives Monaco the new theme listens to the same event; read Monaco's colors after it did.
      setTimeout(() => this.applyTheme(), 0);
    }));
    this._register(watchRequestedLanguages(modelService, languageId => {
      this.requested.add(languageId);
      void this.attach(languageId);
    }));
    this._register(toDisposable(() => {
      this.generation++;
      for (const { registration } of this.tokenizers.values()) {
        registration.dispose();
      }
      this.tokenizers.clear();
      for (const restore of this.restored.values()) {
        restore.dispose();
      }
      this.restored.clear();
      if (this.colorMapApplied) {
        this.monaco?.languages.setColorMap(null);
      }
    }));
  }

  /** Overridden by tests, which have neither the editor package nor a bundler. */
  protected loadMonaco(): Promise<Monaco> {
    return loadMonaco();
  }

  protected loadRuntime(): Promise<ITextMateRuntime> {
    return loadRuntime();
  }

  protected get document(): Document {
    return window.document;
  }

  /** The grammar that tokenizes `languageId`: the one contributed last, as in VS Code. */
  private grammarOf(languageId: string): IContributedGrammar | undefined {
    const grammars = grammarContributions.current;
    for (let i = grammars.length - 1; i >= 0; i--) {
      if (grammars[i].language === languageId) {
        return grammars[i];
      }
    }
    return undefined;
  }

  private grammarsChanged(): void {
    const signature = grammarsSignature(grammarContributions.current);
    if (signature === this.signature) {
      return;
    }
    this.signature = signature;
    this.registry = undefined;
    this.warnedGrammars.clear();
    this.failedScopes.clear();
    for (const [languageId, { registration }] of [...this.tokenizers]) {
      registration.dispose();
      this.tokenizers.delete(languageId);
      if (!this.grammarOf(languageId)) {
        void this.restoreBuiltin(languageId);
      }
    }
    if (!this.tokenizers.size && this.colorMapApplied && ![...this.requested].some(languageId => this.grammarOf(languageId))) {
      this.colorMapApplied = false;
      this.monaco?.languages.setColorMap(null);
    }
    for (const languageId of this.requested) {
      void this.attach(languageId);
    }
  }

  private async ensureRegistry(): Promise<Registry | undefined> {
    if (this.registry?.signature === this.signature) {
      return this.registry.registry;
    }
    let runtime: ITextMateRuntime;
    try {
      runtime = this.registry?.runtime ?? await this.loadRuntime();
    } catch (error) {
      if (!this.warnedRuntime) {
        this.warnedRuntime = true;
        console.warn('Could not load the TextMate engine; languages keep their built-in coloring.', error);
      }
      return undefined;
    }
    if (this.registry?.signature === this.signature) {
      return this.registry.registry;
    }
    const grammars = grammarContributions.current;
    const byScope = new Map<string, IContributedGrammar>();
    for (const grammar of grammars) {
      const previous = byScope.get(grammar.scopeName);
      if (previous) {
        console.warn(`[${grammar.extensionId}] The grammar of '${grammar.scopeName}' replaces the one of ${previous.extensionId}.`);
      }
      byScope.set(grammar.scopeName, grammar);
    }
    const injections = new Map<string, string[]>();
    for (const grammar of byScope.values()) {
      for (const target of grammar.injectTo) {
        injections.set(target, [...injections.get(target) ?? [], grammar.scopeName]);
      }
    }
    const { textMate } = runtime;
    const registry = new textMate.Registry({
      onigLib: Promise.resolve(runtime.onigLib),
      loadGrammar: async scopeName => {
        const grammar = byScope.get(scopeName);
        return grammar ? this.readGrammar(runtime, grammar) : null;
      },
      getInjections: scopeName => injections.get(scopeName),
    });
    this.registry = { registry, signature: this.signature, runtime };
    if (this.monaco) {
      this.applyColorMap(this.monaco, registry);
    }
    return registry;
  }

  private async readGrammar(runtime: ITextMateRuntime, grammar: IContributedGrammar): Promise<IRawGrammar | null> {
    const path = grammar.location.path;
    const warn = (message: string) => {
      this.failedScopes.add(grammar.scopeName);
      const key = grammar.scopeName + '\n' + message;
      if (!this.warnedGrammars.has(key)) {
        this.warnedGrammars.add(key);
        console.warn(`[${grammar.extensionId}] ${grammar.location.toString()}: ${message}`);
      }
    };
    if (!/\.json$/i.test(path)) {
      warn('Only JSON grammars are supported; plist grammars are not.');
      return null;
    }
    try {
      const { value } = await this.fileService.readFile(grammar.location, { limits: { size: extensionResourceLimits.resource } });
      return runtime.textMate.parseRawGrammar(new TextDecoder().decode(value), path);
    } catch (error) {
      warn(`the grammar could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async attach(languageId: string): Promise<void> {
    const signature = this.signature;
    const grammar = this.grammarOf(languageId);
    if (!grammar || this.tokenizers.get(languageId)?.signature === signature) {
      return;
    }
    const attempt = ++this.generation;
    this.attaching.set(languageId, attempt);
    // The extension service hands over new but equal contributions on every refresh (a theme change, say),
    // so what counts is the signature, not the objects.
    const isCurrent = () => this.attaching.get(languageId) === attempt && this.signature === signature;
    try {
      const monaco = this.monaco ??= await this.loadMonaco();
      const registry = await this.ensureRegistry();
      if (!registry || !isCurrent()) {
        return;
      }
      const embeddedLanguages: Record<string, number> = {};
      for (const [scope, embedded] of Object.entries(grammar.embeddedLanguages)) {
        // A scope of an unknown language stays in the outer language.
        if (this.languageService.isRegisteredLanguageId(embedded)) {
          embeddedLanguages[scope] = monaco.languages.getEncodedLanguageId(embedded);
        }
      }
      const encodedLanguageId = monaco.languages.getEncodedLanguageId(languageId);
      let loaded: IGrammar | null;
      try {
        loaded = await registry.loadGrammarWithConfiguration(grammar.scopeName, encodedLanguageId, {
          embeddedLanguages,
          tokenTypes: { ...grammar.tokenTypes } as Record<string, number> as never,
          balancedBracketSelectors: grammar.balancedBracketSelectors ? [...grammar.balancedBracketSelectors] : ['*'],
          unbalancedBracketSelectors: grammar.unbalancedBracketSelectors ? [...grammar.unbalancedBracketSelectors] : [],
        });
      } catch (error) {
        if (!this.failedScopes.has(grammar.scopeName)) {
          console.warn(`[${grammar.extensionId}] The grammar of '${grammar.scopeName}' could not be loaded; '${languageId}' keeps its built-in coloring.`, error);
        }
        return;
      }
      if (!loaded) {
        return;
      }
      // Monaco sets a built-in language's own tokenizer when it first meets it; this one goes after it.
      await waitForBuiltinLanguage(monaco, languageId);
      if (!isCurrent() || this.registry?.registry !== registry) {
        return;
      }
      if (!this.colorMapApplied) {
        this.applyColorMap(monaco, registry);
      }
      this.restored.get(languageId)?.dispose();
      this.restored.delete(languageId);
      this.tokenizers.get(languageId)?.registration.dispose();
      this.tokenizers.delete(languageId);
      const provider = new TextMateTokensProvider(loaded, this.registry.runtime.textMate.INITIAL, encodedLanguageId, languageId);
      try {
        const registration = monaco.languages.setTokensProvider(languageId, provider as unknown as IEncodedTokensProvider);
        this.tokenizers.set(languageId, { signature, registration });
      } catch (error) {
        console.warn(`[${languageId}] Could not use the grammar of '${grammar.scopeName}':`, error);
      }
    } finally {
      if (this.attaching.get(languageId) === attempt) {
        this.attaching.delete(languageId);
      }
    }
  }

  /** Gives a built-in language its own tokenizer again, which Monaco sets only once per language. */
  private async restoreBuiltin(languageId: string): Promise<void> {
    const monaco = this.monaco;
    const definition = monaco?.languages.getLanguages().find(candidate => candidate.id === languageId);
    const loader = (definition as { loader?: () => Promise<{ language?: unknown }> } | undefined)?.loader;
    if (!monaco || typeof loader !== 'function') {
      return;
    }
    try {
      const module = await loader();
      // Only while the language still has no grammar: one that came back meanwhile has its own tokenizer.
      if (module.language && !this.grammarOf(languageId) && !this.tokenizers.has(languageId) && !this.attaching.has(languageId)) {
        this.restored.get(languageId)?.dispose();
        this.restored.set(languageId, monaco.languages.setMonarchTokensProvider(languageId, module.language as never));
      }
    } catch (error) {
      console.warn(`[${languageId}] Could not restore the built-in tokenizer:`, error);
    }
  }

  private applyTheme(): void {
    if (this.monaco && this.registry && this.colorMapApplied) {
      this.applyColorMap(this.monaco, this.registry.registry);
    }
  }

  /**
   * Gives the grammar registry the theme's token colors and Monaco a color map that starts with its own
   * colors, so its built-in tokenizers keep theirs, and continues with the grammar theme's.
   */
  private applyColorMap(monaco: Monaco, registry: Registry): void {
    const theme = toRawTheme(this.themeService.getColorTheme());
    registry.setTheme(theme);
    const grammarColors = registry.getColorMap();
    monaco.languages.setColorMap(null);
    const monacoColors = readMonacoColorMap(monaco, this.document);
    if (!monacoColors) {
      console.warn('Could not read the editor\'s token colors; built-in tokenizers may show other colors.');
    }
    const colorMap = monacoColors ? [...monacoColors] : [''];
    for (const color of grammarColors) {
      if (color && !colorMap.includes(color)) {
        colorMap.push(color);
      }
    }
    registry.setTheme(theme, colorMap);
    monaco.languages.setColorMap(colorMap);
    this.colorMapApplied = true;
  }

  async tokenizeLine(languageId: string, line: string): Promise<{ text: string; scopes: string[] }[] | null> {
    const grammar = this.grammarOf(languageId);
    if (!grammar || typeof line !== 'string') {
      return null;
    }
    const monaco = this.monaco ??= await this.loadMonaco();
    const registry = await this.ensureRegistry();
    if (!registry) {
      return null;
    }
    let loaded: IGrammar | null;
    try {
      loaded = await registry.loadGrammarWithConfiguration(grammar.scopeName, monaco.languages.getEncodedLanguageId(languageId), {});
    } catch {
      return null;
    }
    if (!loaded || !this.registry) {
      return null;
    }
    const { tokens } = loaded.tokenizeLine(line, this.registry.runtime.textMate.INITIAL);
    return tokens.map(token => ({ text: line.slice(token.startIndex, token.endIndex), scopes: token.scopes }))
      .filter(token => token.text.length > 0);
  }
}
