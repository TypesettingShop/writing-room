import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import type { IMonacoTextModel, MonacoNamespace } from '../../../editor/browser/monaco.js';
import { score } from '../../../editor/common/languageSelector.js';
import type { LanguageSelector } from '../../../editor/common/languageSelector.js';
import { IModelService } from '../../../editor/common/services/model.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import type { ITextEditorSelection } from '../../../platform/editor/common/editor.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { EXTERNAL_SCHEMES } from '../../../platform/opener/common/opener.js';
import { registerWorkbenchContribution2 } from '../../common/contributions.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import type { WorkspaceEditOperation } from '../common/extHost.protocol.documents.js';
import type {
  CodeLensDto, CodeLensListDto, ColorInformationDto, ColorPresentationDto, CompletionItemDto, DocumentHighlightDto, DocumentLinkDto,
  DocumentLinkListDto, DocumentSymbolDto, ExecutedCodeActionDto, FoldingRangeDto, FormattingOptionsDto, HoverDto, InlayHintDto,
  InlayHintListDto, LinkedEditingRangesDto, LocationDto, LocationLinkDto, MainThreadNavigationShape, ResolvedCompletionItemDto,
  SemanticTokensDto, SemanticTokensLegendDto,
} from '../common/extHost.protocol.languageFeatures.js';
import type { EditorPosition, EditorRange, EditorSelection, EditorTextEdit } from '../common/extHostTypeConverters.js';
import { checkRegExp, checkSelector, isSynchronized, modelResource, request, whenMonacoLoaded } from './mainThreadLanguageFeatures.js';
import type { MainThreadLanguageFeatures } from './mainThreadLanguageFeatures.js';
import { checkMarkdown, checkRange, text } from './mainThreadLanguageFeaturesCompletions.js';
import { checkTextEdits } from './mainThreadLanguageFeaturesEdits.js';

/*
 * The providers one reads and moves around a document with, on the workbench side: Monaco providers
 * that ask the extension host, with everything the host sends checked before Monaco sees it.
 *
 * - Ranges and lines: the extension host sends Monaco's 1-based values; the workbench checks them.
 * - Links: Monaco gets a link's range and tooltip, never its target. Following a link resolves it
 *   (on the extension host when the provider resolves) and runs a command of this host that opens the
 *   target through the workbench's opener: web addresses once the user agreed, workspace resources in
 *   an editor, and `command:` links only of commands the link's extension contributes.
 * - Code lenses and inlay hints: a list Monaco disposes is released on the extension host, with the
 *   commands of its items. A provider's change event fires the Monaco provider's.
 * - Going to another file: Monaco asks the editor opener the workbench registers once
 *   (`EditorOpenerContribution` below), which opens the resource through the editor service.
 * - The `vscode.execute*` commands: every Monaco provider any group registers is known here
 *   (`trackProviders`); a command calls those whose selector matches the document, best first.
 */

type Languages = MonacoNamespace['languages'];
type Selector = Parameters<Languages['registerDocumentSymbolProvider']>[0];
type MonacoDocumentSymbol = NonNullable<Awaited<ReturnType<Parameters<Languages['registerDocumentSymbolProvider']>[1]['provideDocumentSymbols']>>>[number];
type LinkProvider = Parameters<Languages['registerLinkProvider']>[1];
type MonacoLink = Parameters<NonNullable<LinkProvider['resolveLink']>>[0];
type MonacoLinksList = NonNullable<Awaited<ReturnType<LinkProvider['provideLinks']>>>;
type MonacoHighlight = NonNullable<Awaited<ReturnType<Parameters<Languages['registerDocumentHighlightProvider']>[1]['provideDocumentHighlights']>>>[number];
type MonacoFoldingRange = NonNullable<Awaited<ReturnType<Parameters<Languages['registerFoldingRangeProvider']>[1]['provideFoldingRanges']>>>[number];
type CodeLensProvider = Parameters<Languages['registerCodeLensProvider']>[1];
type MonacoCodeLens = Parameters<NonNullable<CodeLensProvider['resolveCodeLens']>>[1];
type MonacoCodeLensList = NonNullable<Awaited<ReturnType<CodeLensProvider['provideCodeLenses']>>>;
type InlayHintsProvider = Parameters<Languages['registerInlayHintsProvider']>[1];
type MonacoInlayHint = Parameters<NonNullable<InlayHintsProvider['resolveInlayHint']>>[0];
type MonacoInlayHintList = NonNullable<Awaited<ReturnType<InlayHintsProvider['provideInlayHints']>>>;
type MonacoColorInformation = NonNullable<Awaited<ReturnType<Parameters<Languages['registerColorProvider']>[1]['provideDocumentColors']>>>[number];
type MonacoColorPresentation = NonNullable<Awaited<ReturnType<Parameters<Languages['registerColorProvider']>[1]['provideColorPresentations']>>>[number];
type MonacoLinkedEditingRanges = NonNullable<Awaited<ReturnType<Parameters<Languages['registerLinkedEditingRangeProvider']>[1]['provideLinkedEditingRanges']>>>;
type SemanticTokensProvider = Parameters<Languages['registerDocumentSemanticTokensProvider']>[1];
type MonacoSemanticTokens = NonNullable<Awaited<ReturnType<SemanticTokensProvider['provideDocumentSemanticTokens']>>>;
type MonacoRange = NonNullable<ReturnType<typeof checkRange>>;
/** Monaco's `languages.LocationLink`. */
interface MonacoLocationLink {
  uri: ReturnType<MonacoNamespace['Uri']['from']>;
  range: MonacoRange;
  originSelectionRange?: MonacoRange;
  targetSelectionRange?: MonacoRange;
}
type MonacoPosition = Parameters<Parameters<Languages['registerDefinitionProvider']>[1]['provideDefinition']>[1];
type MonacoToken = Parameters<Parameters<Languages['registerDefinitionProvider']>[1]['provideDefinition']>[2];

/** Monaco's token as the RPC takes it: the RPC forwards its cancellation to the extension host. */
const rpcToken = (token: MonacoToken) => token as unknown as CancellationToken;

/** Entries of one answer kept; more are dropped. */
const MAX_ITEMS = 10_000;
const MAX_SYMBOL_DEPTH = 64;
const MAX_CHAIN = 1000;
/** Semantic tokens: five numbers each. */
const MAX_TOKEN_DATA = 5 * 1_000_000;
const MAX_LEGEND = 1024;
/** Monaco's `SymbolKind` runs from File (0) to TypeParameter (25), as the API's. */
const MAX_SYMBOL_KIND = 25;
const PROPERTY_SYMBOL = 6;
const DEPRECATED_TAG = 1;
/** The API's `FoldingRangeKind` numbers and Monaco's kind values. */
const FOLDING_KINDS: Readonly<Record<number, 'Comment' | 'Imports' | 'Region'>> = { 1: 'Comment', 2: 'Imports', 3: 'Region' };

const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isLine = (value: unknown): value is number => isIndex(value) && value >= 1;

function position(value: MonacoPosition): EditorPosition {
  return { lineNumber: value.lineNumber, column: value.column };
}

function monacoUri(monaco: MonacoNamespace, value: unknown) {
  if (!URI.isUri(value)) {
    return undefined;
  }
  const { scheme, authority, path, query, fragment } = value;
  return monaco.Uri.from({ scheme, authority, path, query, fragment });
}

function emptyRange(at: EditorPosition): MonacoRange {
  return { startLineNumber: at.lineNumber, startColumn: at.column, endLineNumber: at.lineNumber, endColumn: at.column };
}

function containsRange(outer: MonacoRange, inner: MonacoRange): boolean {
  const before = (lineA: number, columnA: number, lineB: number, columnB: number) => lineA < lineB || (lineA === lineB && columnA <= columnB);
  return before(outer.startLineNumber, outer.startColumn, inner.startLineNumber, inner.startColumn)
    && before(inner.endLineNumber, inner.endColumn, outer.endLineNumber, outer.endColumn);
}

/** Document symbols as Monaco shows them in the outline; a symbol whose selection range is outside its range is dropped. */
export function checkDocumentSymbols(value: unknown): MonacoDocumentSymbol[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  let count = 0;
  const convert = (values: unknown, depth: number): MonacoDocumentSymbol[] => {
    const result: MonacoDocumentSymbol[] = [];
    if (!Array.isArray(values) || depth > MAX_SYMBOL_DEPTH) {
      return result;
    }
    for (const dto of values as (DocumentSymbolDto | undefined)[]) {
      const name = text(dto?.name);
      const range = checkRange(dto?.range);
      const selectionRange = checkRange(dto?.selectionRange);
      if (count >= MAX_ITEMS || !dto || !name || !range || !selectionRange || !containsRange(range, selectionRange)) {
        continue;
      }
      count++;
      const symbol: MonacoDocumentSymbol = {
        name, detail: text(dto.detail) ?? '',
        kind: Number.isInteger(dto.kind) && dto.kind >= 0 && dto.kind <= MAX_SYMBOL_KIND ? dto.kind : PROPERTY_SYMBOL,
        tags: Array.isArray(dto.tags) && dto.tags.includes(DEPRECATED_TAG) ? [DEPRECATED_TAG] : [],
        range, selectionRange, children: convert(dto.children, depth + 1),
      };
      const container = text(dto.containerName);
      if (container) {
        symbol.containerName = container;
      }
      result.push(symbol);
    }
    return result;
  };
  return convert(value, 1);
}

/** A location the extension host sent, checked; another value gives undefined. */
function checkLocation(value: unknown): LocationLinkDto | undefined {
  const dto = value as Partial<LocationLinkDto> | undefined;
  const range = checkRange(dto?.range);
  if (!dto || !URI.isUri(dto.uri) || !range) {
    return undefined;
  }
  const origin = checkRange(dto.originSelectionRange);
  const target = checkRange(dto.targetSelectionRange);
  return { uri: dto.uri, range, originSelectionRange: origin, targetSelectionRange: target && containsRange(range, target) ? target : undefined };
}

function checkLocations(value: unknown): LocationLinkDto[] | undefined {
  return Array.isArray(value)
    ? value.slice(0, MAX_ITEMS).map(checkLocation).filter((location): location is LocationLinkDto => !!location) : undefined;
}

/** Definitions as Monaco's location links; the URI is Monaco's. */
export function toLocationLinks(monaco: MonacoNamespace, value: unknown): MonacoLocationLink[] | undefined {
  const locations = checkLocations(value);
  return locations?.map(location => {
    const link: MonacoLocationLink = { uri: monacoUri(monaco, location.uri)!, range: location.range };
    if (location.originSelectionRange) {
      link.originSelectionRange = location.originSelectionRange;
    }
    if (location.targetSelectionRange) {
      link.targetSelectionRange = location.targetSelectionRange;
    }
    return link;
  });
}

export function checkHighlights(value: unknown): MonacoHighlight[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: MonacoHighlight[] = [];
  for (const dto of value.slice(0, MAX_ITEMS) as (DocumentHighlightDto | undefined)[]) {
    const range = checkRange(dto?.range);
    if (range) {
      result.push({ range, kind: dto!.kind === 1 || dto!.kind === 2 ? dto!.kind : 0 });
    }
  }
  return result;
}

/** Folding ranges as Monaco takes them: 1-based lines, the end not before the start. */
export function toFoldingRanges(monaco: MonacoNamespace, value: unknown): MonacoFoldingRange[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: MonacoFoldingRange[] = [];
  for (const dto of value.slice(0, MAX_ITEMS) as (FoldingRangeDto | undefined)[]) {
    if (!dto || !isLine(dto.start) || !isLine(dto.end) || dto.end < dto.start) {
      continue;
    }
    const range: MonacoFoldingRange = { start: dto.start, end: dto.end };
    const kind = typeof dto.kind === 'number' ? FOLDING_KINDS[dto.kind] : undefined;
    if (kind) {
      range.kind = monaco.languages.FoldingRangeKind?.[kind] ?? { value: kind.toLowerCase() } as MonacoFoldingRange['kind'];
    }
    result.push(range);
  }
  return result;
}

/** Selection ranges, for each position from the innermost out; a chain stops at a range that does not contain the one before. */
export function checkSelectionRanges(value: unknown, count: number): { range: MonacoRange }[][] | undefined {
  if (!Array.isArray(value) || value.length !== count) {
    return undefined;
  }
  return value.map(chain => {
    const result: { range: MonacoRange }[] = [];
    for (const entry of Array.isArray(chain) ? chain.slice(0, MAX_CHAIN) : []) {
      const range = checkRange(entry);
      if (!range || (result.length && !containsRange(range, result[result.length - 1].range))) {
        break;
      }
      result.push({ range });
    }
    return result;
  });
}

function checkColor(value: unknown): ColorInformationDto['color'] | undefined {
  const color = value as ColorInformationDto['color'] | undefined;
  return color && [color.red, color.green, color.blue, color.alpha].every(channel => typeof channel === 'number' && channel >= 0 && channel <= 1)
    ? { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha } : undefined;
}

function checkTextEdit(value: unknown): EditorTextEdit | undefined {
  return value === undefined ? undefined : checkTextEdits([value])?.[0];
}

function checkTokenData(value: unknown): Uint32Array | undefined {
  return value instanceof Uint32Array && value.length <= MAX_TOKEN_DATA && value.length % 5 === 0 ? value : undefined;
}

/** Semantic tokens or edits, checked: whole tokens of five numbers each. */
export function checkSemanticTokens(value: unknown): MonacoSemanticTokens | undefined {
  const dto = value as SemanticTokensDto | undefined;
  if (!dto || typeof dto !== 'object') {
    return undefined;
  }
  const resultId = typeof dto.resultId === 'string' ? text(dto.resultId, 1024) : undefined;
  if ('edits' in dto) {
    if (!Array.isArray(dto.edits)) {
      return undefined;
    }
    const edits = [];
    for (const edit of dto.edits.slice(0, MAX_ITEMS)) {
      const data = edit?.data === undefined ? undefined : checkTokenData(edit.data);
      if (!edit || !isIndex(edit.start) || !isIndex(edit.deleteCount) || (edit.data !== undefined && !data)) {
        return undefined;
      }
      edits.push(data ? { start: edit.start, deleteCount: edit.deleteCount, data } : { start: edit.start, deleteCount: edit.deleteCount });
    }
    return { resultId, edits };
  }
  const data = checkTokenData((dto as { data?: unknown }).data);
  return data ? { resultId, data } : undefined;
}

/** The selection a link's `#L12` or `#L12,5` fragment names, as VS Code reads it. */
function fragmentSelection(target: URI): { target: URI; selection?: ITextEditorSelection } {
  const match = /^L(\d+)(?:,(\d+))?/.exec(target.fragment);
  if (!match) {
    return { target };
  }
  return {
    target: target.with({ fragment: '' }),
    selection: { startLineNumber: Math.max(1, Number(match[1])), startColumn: Math.max(1, Number(match[2] ?? 1)) },
  };
}

// --- Every Monaco provider of the workbench --------------------------------------------------------

interface TrackedProvider {
  /** The name after `register`, as `HoverProvider`. */
  readonly kind: string;
  readonly selector: LanguageSelector;
  readonly handle: number;
  readonly seam: MainThreadLanguageFeatures;
  readonly monaco: MonacoNamespace;
}

const trackedProviders = new Set<TrackedProvider>();

/**
 * The editor package as a registration of `handle` sees it: each `languages.register*Provider` call is
 * known workbench-wide until its registration is disposed.
 */
export function trackProviders(monaco: MonacoNamespace, seam: MainThreadLanguageFeatures, handle: number): MonacoNamespace {
  const languages = new Proxy(monaco.languages, {
    get(target, name) {
      const value = Reflect.get(target, name);
      if (typeof name !== 'string' || typeof value !== 'function' || !/^register\w*Provider$/.test(name)) {
        return value;
      }
      return (selector: LanguageSelector, ...args: unknown[]) => {
        const disposable = (value as (...values: unknown[]) => IDisposable).call(target, selector, ...args);
        const entry: TrackedProvider = { kind: name.slice('register'.length), selector, handle, seam, monaco };
        trackedProviders.add(entry);
        return { dispose: () => {
          trackedProviders.delete(entry);
          disposable.dispose();
        } };
      };
    },
  });
  return { ...monaco, languages } as MonacoNamespace;
}

/** How many Monaco providers of `kind` the workbench knows, for tests that look for leaks. */
export function trackedProviderCount(kind?: string): number {
  return [...trackedProviders].filter(entry => kind === undefined || entry.kind === kind).length;
}

/**
 * The providers of `kind` for an open, synchronized document, best match first, as VS Code orders them;
 * none when the document is not open.
 */
function providersFor(kind: string, uri: URI): { model: IMonacoTextModel; entries: TrackedProvider[] } | undefined {
  const all = [...trackedProviders].filter(entry => entry.kind === kind);
  if (!all.length || !URI.isUri(uri)) {
    return undefined;
  }
  const { monaco } = all[0];
  const model = monaco.editor.getModel(monacoUri(monaco, uri)!);
  if (!model || !isSynchronized(model)) {
    return undefined;
  }
  const resource = modelResource(model);
  const language = model.getLanguageId();
  const entries = all.map(entry => ({ entry, score: score(entry.selector, resource, language, true) }))
    .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).map(({ entry }) => entry);
  return { model, entries };
}

/** Asks each provider in turn; one that fails or answers nothing is passed over. */
async function each<R>(entries: readonly TrackedProvider[], call: (entry: TrackedProvider) => Promise<R | undefined>): Promise<R[]> {
  const results = await Promise.all(entries.map(entry => call(entry).catch(() => undefined)));
  return results.filter((result): result is Awaited<R> => result !== undefined && result !== null) as R[];
}

/** The first provider's answer that is there, in order. */
async function first<R>(entries: readonly TrackedProvider[], call: (entry: TrackedProvider) => Promise<R | undefined>, empty: (value: R) => boolean = () => false): Promise<R | undefined> {
  for (const entry of entries) {
    const value = await call(entry).catch(() => undefined);
    if (value !== undefined && value !== null && !empty(value)) {
      return value;
    }
  }
  return undefined;
}

// --- The group -------------------------------------------------------------------------------------

interface LinkOrigin {
  readonly id?: number;
  readonly index: number;
  url?: URI;
  /** The references of the list's followed targets, dropped with the list. */
  readonly refs: number[];
}

export class MainThreadNavigation implements MainThreadNavigationShape, IDisposable {
  private readonly events = new Map<number, Emitter<void>>();
  /** Which list and item a Monaco link, code lens or inlay hint is, for resolving. */
  private readonly links = new WeakMap<MonacoLink, LinkOrigin>();
  private readonly lenses = new WeakMap<MonacoCodeLens, { readonly id: number; readonly index: number }>();
  private readonly hints = new WeakMap<MonacoInlayHint, { readonly id: number; readonly index: number }>();
  /** The targets a followed link may open, by reference, until their list goes. */
  private readonly targets = new Map<number, { readonly handle: number; readonly target: URI }>();
  private nextTarget = 0;

  constructor(private readonly seam: MainThreadLanguageFeatures) {
    liveGroups.add(this);
  }

  /** How many link, code lens and inlay hint lists the extension host keeps now. */
  cacheSize(): Promise<number> {
    return this.seam.proxy.$navigationCacheSize();
  }

  /** The event Monaco listens to for `handle`, fired by the provider's change event. */
  private event(handle: number): Emitter<void> {
    let emitter = this.events.get(handle);
    if (!emitter) {
      emitter = new Emitter<void>();
      this.events.set(handle, emitter);
    }
    return emitter;
  }

  /** Registers with Monaco; the provider's event, if any, goes with the registration. */
  private registerWith(extension: string, handle: number, selector: unknown, create: (monaco: MonacoNamespace, selector: Selector) => IDisposable): Promise<void> {
    const checked = checkSelector(selector) as Selector;
    return this.seam.register(extension, handle, monaco => {
      const disposable = create(monaco, checked);
      return { dispose: () => {
        disposable.dispose();
        this.events.get(handle)?.dispose();
        this.events.delete(handle);
      } };
    });
  }

  async $emitProviderEvent(extension: string, handle: number): Promise<void> {
    if (this.seam.isRegistered(extension, handle)) {
      this.events.get(handle)?.fire();
    }
  }

  // --- Document symbols ----------------------------------------------------------------------------

  $registerDocumentSymbolSupport(extension: string, handle: number, selector: unknown, label: unknown): Promise<void> {
    const displayName = text(label);
    return this.registerWith(extension, handle, selector, (monaco, checked) => monaco.languages.registerDocumentSymbolProvider(checked, {
      displayName,
      provideDocumentSymbols: async (model, token) => checkDocumentSymbols(await request(model, token, uri =>
        this.seam.proxy.$provideDocumentSymbols(handle, uri, rpcToken(token)))),
    }));
  }

  // --- Links ---------------------------------------------------------------------------------------

  $registerDocumentLinkSupport(extension: string, handle: number, selector: unknown, supportsResolve: unknown): Promise<void> {
    return this.registerWith(extension, handle, selector, (monaco, checked) => monaco.languages.registerLinkProvider(checked, {
      provideLinks: (model, token) => this.provideLinks(handle, model, token),
      // Every link resolves: Monaco gets the command that follows it only when the user follows it.
      resolveLink: (link, token) => this.resolveLink(monaco, handle, link, token, supportsResolve === true),
    }));
  }

  private async provideLinks(handle: number, model: IMonacoTextModel, token: MonacoToken): Promise<MonacoLinksList | undefined> {
    const release = (id: unknown) => {
      if (isIndex(id)) {
        void this.seam.proxy.$releaseDocumentLinks(handle, id).catch(() => {});
      }
    };
    const dto = await request(model, token, async uri => {
      const result = await this.seam.proxy.$provideDocumentLinks(handle, uri, rpcToken(token));
      if (result && token.isCancellationRequested) {
        release(result.id);
      }
      return result;
    });
    if (!dto || typeof dto !== 'object' || !Array.isArray(dto.links)) {
      release(dto?.id);
      return undefined;
    }
    const id = isIndex(dto.id) ? dto.id : undefined;
    const links: MonacoLink[] = [];
    const targets: number[] = [];
    for (const link of dto.links.slice(0, MAX_ITEMS) as (DocumentLinkDto | undefined)[]) {
      const range = checkRange(link?.range);
      if (!link || !range || !isIndex(link.index)) {
        continue;
      }
      const result: MonacoLink = { range };
      const tooltip = text(link.tooltip);
      if (tooltip) {
        result.tooltip = tooltip;
      }
      this.links.set(result, { id, index: link.index, url: URI.isUri(link.url) ? link.url : undefined, refs: targets });
      links.push(result);
    }
    let released = false;
    return {
      links,
      dispose: () => {
        if (!released) {
          released = true;
          release(id);
          for (const ref of targets) {
            this.targets.delete(ref);
          }
        }
      },
    };
  }

  private async resolveLink(monaco: MonacoNamespace, handle: number, link: MonacoLink, token: MonacoToken, supportsResolve: boolean): Promise<MonacoLink | undefined> {
    const origin = this.links.get(link);
    if (!origin) {
      return undefined;
    }
    if (!origin.url && supportsResolve && origin.id !== undefined) {
      const resolved = await this.seam.proxy.$resolveDocumentLink(handle, origin.id, origin.index, rpcToken(token)).catch(() => undefined);
      if (token.isCancellationRequested) {
        return undefined;
      }
      origin.url = URI.isUri(resolved?.url) ? resolved.url : undefined;
    }
    if (!origin.url) {
      return undefined;
    }
    const ref = ++this.nextTarget;
    this.targets.set(ref, { handle, target: origin.url });
    origin.refs.push(ref);
    const command = this.seam.monacoCommand(monaco, 'followLink', value => this.followLink(value));
    return { ...link, url: monaco.Uri.from({ scheme: 'command', path: command, query: JSON.stringify([ref]) }) };
  }

  /**
   * Follows a link's target through the opener: `command:` links only of the commands the extension
   * contributes; a `#L12,5` fragment of a resource is the selection of the editor that opens.
   */
  private async followLink(ref: unknown): Promise<void> {
    if (!isIndex(ref)) {
      return;
    }
    const entry = this.targets.get(ref);
    const extension = entry && this.seam.extension(entry.handle);
    if (!entry || !extension) {
      return;
    }
    const scheme = entry.target.scheme.toLowerCase();
    if (EXTERNAL_SCHEMES.has(scheme)) {
      // Monaco follows on mouseup. Let the gesture's following click finish before showing Quick Pick.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (this.targets.get(ref) === entry && this.seam.extension(entry.handle) === extension) {
        await this.seam.openLink(entry.target, {});
      }
      return;
    }
    const contributed = (extension.manifest.contributes as { commands?: unknown } | undefined)?.commands;
    const allowCommands = (Array.isArray(contributed) ? contributed : [contributed])
      .map(command => (command as { command?: unknown } | undefined)?.command)
      .filter((command): command is string => typeof command === 'string' && command.length > 0);
    const { target, selection } = scheme === 'command'
      ? { target: entry.target, selection: undefined }
      : fragmentSelection(entry.target);
    const opened = await this.seam.openLink(target, { allowCommands, selection });
    if (!opened) {
      this.seam.warn(scheme === 'command'
        ? `The link's command '${target.path}' is not one its extension contributes.`
        : `The link's target '${target.toString(true)}' could not be opened.`);
    }
  }

  // --- Definitions and references ------------------------------------------------------------------

  private registerDefinitions(extension: string, handle: number, selector: unknown, register: 'registerDefinitionProvider' | 'registerDeclarationProvider'
    | 'registerTypeDefinitionProvider' | 'registerImplementationProvider', method: 'provideDefinition' | 'provideDeclaration' | 'provideTypeDefinition'
    | 'provideImplementation', call: (uri: URI, at: EditorPosition, token: CancellationToken) => Promise<LocationLinkDto[] | undefined>): Promise<void> {
    return this.registerWith(extension, handle, selector, (monaco, checked) => (monaco.languages[register] as (selector: Selector, provider: object) => IDisposable)(checked, {
      [method]: async (model: IMonacoTextModel, at: MonacoPosition, token: MonacoToken) =>
        toLocationLinks(monaco, await request(model, token, uri => call(uri, position(at), rpcToken(token)))),
    }));
  }

  $registerDefinitionSupport(extension: string, handle: number, selector: unknown): Promise<void> {
    return this.registerDefinitions(extension, handle, selector, 'registerDefinitionProvider', 'provideDefinition',
      (uri, at, token) => this.seam.proxy.$provideDefinition(handle, uri, at, token));
  }

  $registerDeclarationSupport(extension: string, handle: number, selector: unknown): Promise<void> {
    return this.registerDefinitions(extension, handle, selector, 'registerDeclarationProvider', 'provideDeclaration',
      (uri, at, token) => this.seam.proxy.$provideDeclaration(handle, uri, at, token));
  }

  $registerTypeDefinitionSupport(extension: string, handle: number, selector: unknown): Promise<void> {
    return this.registerDefinitions(extension, handle, selector, 'registerTypeDefinitionProvider', 'provideTypeDefinition',
      (uri, at, token) => this.seam.proxy.$provideTypeDefinition(handle, uri, at, token));
  }

  $registerImplementationSupport(extension: string, handle: number, selector: unknown): Promise<void> {
    return this.registerDefinitions(extension, handle, selector, 'registerImplementationProvider', 'provideImplementation',
      (uri, at, token) => this.seam.proxy.$provideImplementation(handle, uri, at, token));
  }

  $registerReferenceSupport(extension: string, handle: number, selector: unknown): Promise<void> {
    return this.registerWith(extension, handle, selector, (monaco, checked) => monaco.languages.registerReferenceProvider(checked, {
      provideReferences: async (model, at, context, token) => toLocationLinks(monaco, await request(model, token, uri =>
        this.seam.proxy.$provideReferences(handle, uri, position(at), context?.includeDeclaration === true, rpcToken(token))))
        ?.map(({ uri, range }) => ({ uri, range })),
    }));
  }

  // --- Highlights, folding and selection ranges ----------------------------------------------------

  $registerDocumentHighlightSupport(extension: string, handle: number, selector: unknown): Promise<void> {
    return this.registerWith(extension, handle, selector, (monaco, checked) => monaco.languages.registerDocumentHighlightProvider(checked, {
      provideDocumentHighlights: async (model, at, token) => checkHighlights(await request(model, token, uri =>
        this.seam.proxy.$provideDocumentHighlights(handle, uri, position(at), rpcToken(token)))),
    }));
  }

  $registerFoldingRangeSupport(extension: string, handle: number, selector: unknown, hasEvent: unknown): Promise<void> {
    return this.registerWith(extension, handle, selector, (monaco, checked) => {
      const provider: Parameters<Languages['registerFoldingRangeProvider']>[1] = {
        provideFoldingRanges: async (model, _context, token) => toFoldingRanges(monaco, await request(model, token, uri =>
          this.seam.proxy.$provideFoldingRanges(handle, uri, rpcToken(token)))),
      };
      if (hasEvent === true) {
        const emitter = this.event(handle);
        provider.onDidChange = ((listener: (provider: unknown) => void, thisArg?: unknown) =>
          emitter.event(() => listener.call(thisArg, provider))) as NonNullable<typeof provider.onDidChange>;
      }
      return monaco.languages.registerFoldingRangeProvider(checked, provider);
    });
  }

  $registerSelectionRangeSupport(extension: string, handle: number, selector: unknown): Promise<void> {
    return this.registerWith(extension, handle, selector, (monaco, checked) => monaco.languages.registerSelectionRangeProvider(checked, {
      provideSelectionRanges: async (model, positions, token) => {
        const at = positions.slice(0, MAX_CHAIN).map(position);
        return checkSelectionRanges(await request(model, token, uri => this.seam.proxy.$provideSelectionRanges(handle, uri, at, rpcToken(token))), at.length);
      },
    }));
  }

  // --- Code lenses ---------------------------------------------------------------------------------

  $registerCodeLensSupport(extension: string, handle: number, selector: unknown, supportsResolve: unknown, hasEvent: unknown): Promise<void> {
    return this.registerWith(extension, handle, selector, (monaco, checked) => {
      const provider: CodeLensProvider = {
        provideCodeLenses: (model, token) => this.provideCodeLenses(monaco, handle, model, token),
      };
      if (supportsResolve === true) {
        provider.resolveCodeLens = (_model, lens, token) => this.resolveCodeLens(monaco, handle, lens, token);
      }
      if (hasEvent === true) {
        const emitter = this.event(handle);
        provider.onDidChange = ((listener: (provider: unknown) => void, thisArg?: unknown) =>
          emitter.event(() => listener.call(thisArg, provider))) as NonNullable<CodeLensProvider['onDidChange']>;
      }
      return monaco.languages.registerCodeLensProvider(checked, provider);
    });
  }

  private async provideCodeLenses(monaco: MonacoNamespace, handle: number, model: IMonacoTextModel, token: MonacoToken): Promise<MonacoCodeLensList | undefined> {
    const release = (id: unknown) => {
      if (isIndex(id)) {
        void this.seam.proxy.$releaseCodeLenses(handle, id).catch(() => {});
      }
    };
    const dto: CodeLensListDto | undefined = await request(model, token, async uri => {
      const result = await this.seam.proxy.$provideCodeLenses(handle, uri, rpcToken(token));
      if (result && token.isCancellationRequested) {
        release(result.id);
      }
      return result;
    });
    if (!dto || typeof dto !== 'object' || !isIndex(dto.id) || !Array.isArray(dto.lenses)) {
      release(dto?.id);
      return undefined;
    }
    const lenses: MonacoCodeLens[] = [];
    for (const lens of dto.lenses.slice(0, MAX_ITEMS)) {
      const result = this.toCodeLens(monaco, lens);
      if (result) {
        this.lenses.set(result, { id: dto.id, index: lens.index });
        lenses.push(result);
      }
    }
    let released = false;
    return { lenses, dispose: () => {
      if (!released) {
        released = true;
        release(dto.id);
      }
    } };
  }

  private toCodeLens(monaco: MonacoNamespace, dto: CodeLensDto | undefined): MonacoCodeLens | undefined {
    const range = checkRange(dto?.range);
    if (!dto || !range || !isIndex(dto.index)) {
      return undefined;
    }
    const command = this.seam.toMonacoCommand(monaco, dto.command);
    return command ? { range, command } : { range };
  }

  private async resolveCodeLens(monaco: MonacoNamespace, handle: number, lens: MonacoCodeLens, token: MonacoToken): Promise<MonacoCodeLens | undefined> {
    const origin = this.lenses.get(lens);
    if (!origin || token.isCancellationRequested) {
      return lens;
    }
    const dto = await this.seam.proxy.$resolveCodeLens(handle, origin.id, origin.index, rpcToken(token)).catch(() => undefined);
    const resolved = !token.isCancellationRequested ? this.toCodeLens(monaco, dto) : undefined;
    if (!resolved) {
      return lens;
    }
    this.lenses.set(resolved, origin);
    return resolved;
  }

  // --- Colors --------------------------------------------------------------------------------------

  $registerColorSupport(extension: string, handle: number, selector: unknown): Promise<void> {
    return this.registerWith(extension, handle, selector, (monaco, checked) => monaco.languages.registerColorProvider(checked, {
      provideDocumentColors: async (model, token) => {
        const value = await request(model, token, uri => this.seam.proxy.$provideDocumentColors(handle, uri, rpcToken(token)));
        if (!Array.isArray(value)) {
          return undefined;
        }
        const result: MonacoColorInformation[] = [];
        for (const info of value.slice(0, MAX_ITEMS)) {
          const range = checkRange(info?.range);
          const color = checkColor(info?.color);
          if (range && color) {
            result.push({ range, color });
          }
        }
        return result;
      },
      provideColorPresentations: async (model, info, token) => {
        const range = checkRange(info?.range);
        const color = checkColor(info?.color);
        const value = range && color && await request(model, token, uri =>
          this.seam.proxy.$provideColorPresentations(handle, uri, { range, color }, rpcToken(token)));
        if (!Array.isArray(value)) {
          return undefined;
        }
        const result: MonacoColorPresentation[] = [];
        for (const presentation of value.slice(0, MAX_ITEMS) as (ColorPresentationDto | undefined)[]) {
          const label = text(presentation?.label);
          if (!presentation || !label) {
            continue;
          }
          const entry: MonacoColorPresentation = { label };
          const edit = checkTextEdit(presentation.textEdit);
          if (edit) {
            entry.textEdit = edit;
          }
          const additional = checkTextEdits(presentation.additionalTextEdits);
          if (additional?.length) {
            entry.additionalTextEdits = additional;
          }
          result.push(entry);
        }
        return result;
      },
    }));
  }

  // --- Inlay hints ---------------------------------------------------------------------------------

  $registerInlayHintsSupport(extension: string, handle: number, selector: unknown, supportsResolve: unknown, hasEvent: unknown, displayName: unknown): Promise<void> {
    const name = text(displayName);
    return this.registerWith(extension, handle, selector, (monaco, checked) => {
      const provider: InlayHintsProvider = {
        displayName: name,
        provideInlayHints: (model, range, token) => this.provideInlayHints(monaco, handle, model, range, token),
      };
      if (supportsResolve === true) {
        provider.resolveInlayHint = (hint, token) => this.resolveInlayHint(monaco, handle, hint, token);
      }
      if (hasEvent === true) {
        provider.onDidChangeInlayHints = this.event(handle).event as NonNullable<InlayHintsProvider['onDidChangeInlayHints']>;
      }
      return monaco.languages.registerInlayHintsProvider(checked, provider);
    });
  }

  private async provideInlayHints(monaco: MonacoNamespace, handle: number, model: IMonacoTextModel, range: MonacoRange, token: MonacoToken): Promise<MonacoInlayHintList | undefined> {
    const release = (id: unknown) => {
      if (isIndex(id)) {
        void this.seam.proxy.$releaseInlayHints(handle, id).catch(() => {});
      }
    };
    const at: EditorRange = { startLineNumber: range.startLineNumber, startColumn: range.startColumn, endLineNumber: range.endLineNumber, endColumn: range.endColumn };
    const dto: InlayHintListDto | undefined = await request(model, token, async uri => {
      const result = await this.seam.proxy.$provideInlayHints(handle, uri, at, rpcToken(token));
      if (result && token.isCancellationRequested) {
        release(result.id);
      }
      return result;
    });
    if (!dto || typeof dto !== 'object' || !isIndex(dto.id) || !Array.isArray(dto.hints)) {
      release(dto?.id);
      return undefined;
    }
    const hints: MonacoInlayHint[] = [];
    for (const hint of dto.hints.slice(0, MAX_ITEMS)) {
      const result = this.toInlayHint(monaco, hint);
      if (result) {
        this.hints.set(result, { id: dto.id, index: hint.index });
        hints.push(result);
      }
    }
    let released = false;
    return { hints, dispose: () => {
      if (!released) {
        released = true;
        release(dto.id);
      }
    } };
  }

  private toInlayHint(monaco: MonacoNamespace, dto: InlayHintDto | undefined): MonacoInlayHint | undefined {
    if (!dto || !isIndex(dto.index) || !isLine(dto.position?.lineNumber) || !isLine(dto.position?.column)) {
      return undefined;
    }
    const tooltip = (value: unknown) => typeof value === 'string' ? text(value) : checkMarkdown(value);
    let label: MonacoInlayHint['label'];
    if (typeof dto.label === 'string') {
      label = text(dto.label) ?? '';
    } else if (Array.isArray(dto.label)) {
      label = dto.label.slice(0, MAX_CHAIN).flatMap(part => {
        const value = text(part?.label);
        if (!value) {
          return [];
        }
        const result: Exclude<MonacoInlayHint['label'], string>[number] = { label: value };
        const partTooltip = tooltip(part.tooltip);
        if (partTooltip) {
          result.tooltip = partTooltip;
        }
        const location = checkLocation(part.location);
        if (location) {
          result.location = { uri: monacoUri(monaco, location.uri)!, range: location.range };
        }
        const command = this.seam.toMonacoCommand(monaco, part.command);
        if (command) {
          result.command = command;
        }
        return [result];
      });
    } else {
      return undefined;
    }
    if (!label.length) {
      return undefined;
    }
    const hint: MonacoInlayHint = { label, position: { lineNumber: dto.position.lineNumber, column: dto.position.column } };
    const hintTooltip = tooltip(dto.tooltip);
    if (hintTooltip) {
      hint.tooltip = hintTooltip;
    }
    if (dto.kind === 1 || dto.kind === 2) {
      hint.kind = dto.kind;
    }
    const edits = checkTextEdits(dto.textEdits);
    if (edits?.length) {
      hint.textEdits = edits;
    }
    if (dto.paddingLeft === true) {
      hint.paddingLeft = true;
    }
    if (dto.paddingRight === true) {
      hint.paddingRight = true;
    }
    return hint;
  }

  private async resolveInlayHint(monaco: MonacoNamespace, handle: number, hint: MonacoInlayHint, token: MonacoToken): Promise<MonacoInlayHint> {
    const origin = this.hints.get(hint);
    if (!origin || token.isCancellationRequested) {
      return hint;
    }
    const dto = await this.seam.proxy.$resolveInlayHint(handle, origin.id, origin.index, rpcToken(token)).catch(() => undefined);
    const resolved = !token.isCancellationRequested ? this.toInlayHint(monaco, dto) : undefined;
    if (!resolved) {
      return hint;
    }
    // The hint stays where Monaco shows it.
    resolved.position = hint.position;
    this.hints.set(resolved, origin);
    return resolved;
  }

  // --- Linked editing and semantic tokens ----------------------------------------------------------

  $registerLinkedEditingRangeSupport(extension: string, handle: number, selector: unknown): Promise<void> {
    return this.registerWith(extension, handle, selector, (monaco, checked) => monaco.languages.registerLinkedEditingRangeProvider(checked, {
      provideLinkedEditingRanges: async (model, at, token) => {
        const dto: LinkedEditingRangesDto | undefined = await request(model, token, uri =>
          this.seam.proxy.$provideLinkedEditingRanges(handle, uri, position(at), rpcToken(token)));
        if (!dto || typeof dto !== 'object' || !Array.isArray(dto.ranges)) {
          return undefined;
        }
        const ranges = dto.ranges.slice(0, MAX_ITEMS).map(checkRange).filter((range): range is MonacoRange => !!range);
        let wordPattern: RegExp | undefined;
        try {
          wordPattern = checkRegExp(dto.wordPattern);
        } catch {
          wordPattern = undefined;
        }
        const result: MonacoLinkedEditingRanges = { ranges };
        if (wordPattern && !wordPattern.test('')) {
          result.wordPattern = wordPattern;
        }
        return result;
      },
    }));
  }

  $registerDocumentSemanticTokensSupport(extension: string, handle: number, selector: unknown, legend: unknown, hasEvent: unknown): Promise<void> {
    const value = (legend && typeof legend === 'object' ? legend : {}) as Partial<SemanticTokensLegendDto>;
    const strings = (values: unknown) => Array.isArray(values)
      ? values.slice(0, MAX_LEGEND).map(entry => text(entry, 256) ?? '') : [];
    const checkedLegend = { tokenTypes: strings(value.tokenTypes), tokenModifiers: strings(value.tokenModifiers) };
    return this.registerWith(extension, handle, selector, (monaco, checked) => {
      const provider: SemanticTokensProvider = {
        getLegend: () => checkedLegend,
        provideDocumentSemanticTokens: async (model, lastResultId, token) => checkSemanticTokens(await request(model, token, uri =>
          this.seam.proxy.$provideDocumentSemanticTokens(handle, uri, typeof lastResultId === 'string' ? lastResultId : undefined, rpcToken(token)))),
        // The extension host keeps no tokens: the provider computes edits against its own last result.
        releaseDocumentSemanticTokens: () => {},
      };
      if (hasEvent === true) {
        (provider as { onDidChange?: unknown }).onDidChange = this.event(handle).event;
      }
      return monaco.languages.registerDocumentSemanticTokensProvider(checked, provider);
    });
  }

  // --- The `vscode.execute*` commands ----------------------------------------------------------------

  async $executeDocumentSymbolProvider(uri: URI): Promise<DocumentSymbolDto[]> {
    const found = providersFor('DocumentSymbolProvider', uri);
    if (!found) {
      return [];
    }
    // As in VS Code: the first provider that has symbols.
    const symbols = await first(found.entries, async entry =>
      checkDocumentSymbols(await entry.seam.proxy.$provideDocumentSymbols(entry.handle, modelResource(found.model), none())), value => !value.length);
    const toDto = (symbol: MonacoDocumentSymbol): DocumentSymbolDto => ({
      name: symbol.name, detail: symbol.detail, kind: symbol.kind, tags: [...symbol.tags], containerName: symbol.containerName,
      range: symbol.range, selectionRange: symbol.selectionRange, children: symbol.children?.map(toDto),
    });
    return symbols?.map(toDto) ?? [];
  }

  async $executeLinkProvider(uri: URI, resolveCount: number): Promise<{ range: EditorRange; url?: URI; tooltip?: string }[]> {
    const found = providersFor('LinkProvider', uri);
    if (!found) {
      return [];
    }
    let remaining = isIndex(resolveCount) ? resolveCount : 0;
    const lists = await each(found.entries, async entry => {
      const list: DocumentLinkListDto | undefined = await entry.seam.proxy.$provideDocumentLinks(entry.handle, modelResource(found.model), none());
      if (!list || !Array.isArray(list.links)) {
        return undefined;
      }
      const links = [];
      for (const link of list.links.slice(0, MAX_ITEMS)) {
        const range = checkRange(link?.range);
        if (!range) {
          continue;
        }
        let url = URI.isUri(link.url) ? link.url : undefined;
        let tooltip = text(link.tooltip);
        if (!url && isIndex(list.id) && remaining > 0) {
          remaining--;
          const resolved = await entry.seam.proxy.$resolveDocumentLink(entry.handle, list.id, link.index, none()).catch(() => undefined);
          url = URI.isUri(resolved?.url) ? resolved.url : undefined;
          tooltip = text(resolved?.tooltip) ?? tooltip;
        }
        links.push({ range, url, tooltip });
      }
      if (isIndex(list.id)) {
        void entry.seam.proxy.$releaseDocumentLinks(entry.handle, list.id).catch(() => {});
      }
      return links;
    });
    return lists.flat();
  }

  async $executeDefinitionProvider(uri: URI, at: EditorPosition): Promise<LocationLinkDto[]> {
    const found = providersFor('DefinitionProvider', uri);
    return found ? (await each(found.entries, async entry =>
      checkLocations(await entry.seam.proxy.$provideDefinition(entry.handle, modelResource(found.model), at, none())))).flat() : [];
  }

  async $executeReferenceProvider(uri: URI, at: EditorPosition): Promise<LocationDto[]> {
    const found = providersFor('ReferenceProvider', uri);
    return found ? (await each(found.entries, async entry =>
      checkLocations(await entry.seam.proxy.$provideReferences(entry.handle, modelResource(found.model), at, true, none())))).flat()
      .map(({ uri, range }) => ({ uri, range })) : [];
  }

  async $executeHoverProvider(uri: URI, at: EditorPosition): Promise<HoverDto[]> {
    const found = providersFor('HoverProvider', uri);
    return found ? each(found.entries, async entry => {
      const hover = await entry.seam.proxy.$provideHover(entry.handle, modelResource(found.model), at, none());
      const contents = Array.isArray(hover?.contents) ? hover.contents.map(checkMarkdown).filter(part => !!part) : [];
      return contents.length ? { contents: contents as HoverDto['contents'], range: checkRange(hover?.range) } : undefined;
    }) : [];
  }

  async $executeCompletionItemProvider(uri: URI, at: EditorPosition, triggerCharacter: string | undefined, resolveCount: number): Promise<{ incomplete: boolean; items: (CompletionItemDto & ResolvedCompletionItemDto)[] }> {
    const found = providersFor('CompletionItemProvider', uri);
    if (!found) {
      return { incomplete: false, items: [] };
    }
    let remaining = isIndex(resolveCount) ? resolveCount : 0;
    let incomplete = false;
    const lists = await each(found.entries, async entry => {
      const context = typeof triggerCharacter === 'string' && triggerCharacter ? { triggerKind: 1, triggerCharacter } : { triggerKind: 0 };
      const list = await entry.seam.proxy.$provideCompletionItems(entry.handle, modelResource(found.model), at, context, none());
      if (!list || !Array.isArray(list.items)) {
        return undefined;
      }
      incomplete ||= list.incomplete === true;
      const items: (CompletionItemDto & ResolvedCompletionItemDto)[] = [];
      for (const item of list.items.slice(0, MAX_ITEMS)) {
        if (!item || !isIndex(item.index)) {
          continue;
        }
        let resolved: ResolvedCompletionItemDto | undefined;
        if (remaining > 0) {
          remaining--;
          resolved = await entry.seam.proxy.$resolveCompletionItem(entry.handle, list.id, item.index, none()).catch(() => undefined);
        }
        // The command stays on the extension host that gave it.
        items.push({ ...item, range: item.range ?? list.defaults, ...resolved, command: undefined });
      }
      void entry.seam.proxy.$releaseCompletionItems(entry.handle, list.id).catch(() => {});
      return items;
    });
    return { incomplete, items: lists.flat() };
  }

  private async format(kind: string, uri: URI, call: (entry: TrackedProvider, resource: URI) => Promise<{ edits: readonly EditorTextEdit[] } | undefined>): Promise<EditorTextEdit[] | undefined> {
    const found = providersFor(kind, uri);
    if (!found) {
      return undefined;
    }
    // As in VS Code: the first formatter, as Monaco would pick it.
    return first(found.entries, async entry => checkTextEdits((await call(entry, modelResource(found.model)))?.edits));
  }

  $executeFormatDocumentProvider(uri: URI, options: FormattingOptionsDto): Promise<EditorTextEdit[] | undefined> {
    return this.format('DocumentFormattingEditProvider', uri, (entry, resource) =>
      entry.seam.proxy.$provideDocumentFormattingEdits(entry.handle, resource, options, none()));
  }

  $executeFormatRangeProvider(uri: URI, range: EditorRange, options: FormattingOptionsDto): Promise<EditorTextEdit[] | undefined> {
    const checked = checkRange(range);
    return checked ? this.format('DocumentRangeFormattingEditProvider', uri, (entry, resource) =>
      entry.seam.proxy.$provideDocumentRangeFormattingEdits(entry.handle, resource, checked, options, none())) : Promise.resolve(undefined);
  }

  async $executeCodeActionProvider(uri: URI, range: EditorRange | EditorSelection, kind: string | undefined, resolveCount: number): Promise<ExecutedCodeActionDto[]> {
    const found = providersFor('CodeActionProvider', uri);
    if (!found || !checkRange(range)) {
      return [];
    }
    return (await each(found.entries, entry => entry.seam.proxy.$provideCodeActionsForCommand(
      entry.handle, modelResource(found.model), range, typeof kind === 'string' ? text(kind) : undefined, isIndex(resolveCount) ? resolveCount : 0, none()))).flat();
  }

  async $executeDocumentRenameProvider(uri: URI, at: EditorPosition, newName: string): Promise<WorkspaceEditOperation[] | { readonly rejectReason: string } | undefined> {
    const found = providersFor('RenameProvider', uri);
    if (!found || typeof newName !== 'string') {
      return undefined;
    }
    // As in VS Code: the first provider that gives an edit; one that refuses passes the turn to the next,
    // and the reasons of all are the refusal when none gives one.
    const reasons: string[] = [];
    for (const entry of found.entries) {
      const value = await entry.seam.proxy.$provideRenameEditsForCommand(entry.handle, modelResource(found.model), at, newName, none())
        .catch(() => undefined);
      if (Array.isArray(value)) {
        return value;
      }
      const reason = value && typeof value === 'object' ? text((value as { rejectReason?: unknown }).rejectReason) : undefined;
      if (reason) {
        reasons.push(reason);
      }
    }
    return reasons.length ? { rejectReason: reasons.join('\n') } : undefined;
  }

  dispose(): void {
    liveGroups.delete(this);
    for (const emitter of this.events.values()) {
      emitter.dispose();
    }
    this.events.clear();
    this.targets.clear();
  }
}

/** A token that is never cancelled: the API commands run to the end. */
function none(): CancellationToken {
  return { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as unknown as CancellationToken;
}

/** The navigation groups of the hosts alive now. */
const liveGroups = new Set<MainThreadNavigation>();

/**
 * How many link, code lens and inlay hint lists the extension hosts keep now, for tests that look for
 * leaks. Not in the command palette.
 */
CommandsRegistry.registerCommand('_workbench.languageFeatures.navigationCacheSize', async () => {
  const sizes = await Promise.all([...liveGroups].map(group => group.cacheSize().catch(() => 0)));
  return sizes.reduce((sum, size) => sum + size, 0);
});

/** The group's factory; a function declaration, so the seam can list it while the two modules load each other. */
export function createMainThreadNavigation(seam: MainThreadLanguageFeatures): MainThreadNavigation {
  return new MainThreadNavigation(seam);
}

// --- Going to another file -------------------------------------------------------------------------

/** What opening a resource from the editor needs: the editor package, the editor service, and what can be opened. */
export interface EditorOpenerServices {
  readonly openEditor: (resource: URI, selection: ITextEditorSelection | undefined) => Promise<boolean>;
  /** Whether a file system provider, or an open model, has the resource. */
  readonly canOpen: (resource: URI) => boolean;
  readonly warn: (message: string) => void;
}

/**
 * The opener Monaco asks when going to a definition (or a reference, an implementation...) in another
 * model: the resource opens in an editor with the target selected. A scheme no file system provider
 * handles, or an editor that does not open, tells the user why instead.
 */
export function createEditorOpener(services: EditorOpenerServices) {
  return {
    openCodeEditor: async (_source: unknown, resource: { scheme: string; authority: string; path: string; query: string; fragment: string },
      selectionOrPosition?: { startLineNumber: number; startColumn: number; endLineNumber?: number; endColumn?: number } | { lineNumber: number; column: number }) => {
      const target = URI.from({ scheme: resource.scheme, authority: resource.authority, path: resource.path, query: resource.query, fragment: resource.fragment });
      const selection: ITextEditorSelection | undefined = !selectionOrPosition ? undefined : 'lineNumber' in selectionOrPosition
        ? { startLineNumber: selectionOrPosition.lineNumber, startColumn: selectionOrPosition.column }
        : { startLineNumber: selectionOrPosition.startLineNumber, startColumn: selectionOrPosition.startColumn, endLineNumber: selectionOrPosition.endLineNumber, endColumn: selectionOrPosition.endColumn };
      if (!services.canOpen(target)) {
        services.warn(`Cannot open '${target.toString(true)}': no file system provider handles '${target.scheme}' resources.`);
        return true;
      }
      let opened = false;
      try {
        opened = await services.openEditor(target, selection);
      } catch {
        opened = false;
      }
      if (!opened) {
        services.warn(`Cannot open '${target.toString(true)}'.`);
      }
      return true;
    },
  };
}

/** Registers the editor opener with Monaco once, for the whole workbench, when the editor package has loaded. */
export class EditorOpenerContribution extends Disposable {
  static readonly ID = 'workbench.contrib.languageFeatures.editorOpener';

  constructor(
    @IModelService models: IModelService,
    @IEditorService editors: IEditorService,
    @IFileService files: IFileService,
    @INotificationService notifications: INotificationService,
  ) {
    super();
    const loaded = whenMonacoLoaded(models);
    this._register({ dispose: () => loaded.dispose() });
    let disposed = false;
    this._register({ dispose: () => { disposed = true; } });
    const opener = createEditorOpener({
      openEditor: async (resource, selection) => !!await editors.openEditor({ resource, options: { selection } }),
      canOpen: resource => files.hasProvider(resource) || !!models.getModel(resource),
      warn: message => notifications.warn(message),
    });
    void loaded.promise.then(monaco => {
      if (!disposed) {
        this._register(monaco.editor.registerEditorOpener(opener as Parameters<MonacoNamespace['editor']['registerEditorOpener']>[0]));
      }
    }, () => {});
  }
}

registerWorkbenchContribution2(EditorOpenerContribution.ID, EditorOpenerContribution);
