import type * as vscode from 'vscode';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { WorkspaceEditOperation } from './extHost.protocol.documents.js';
import type { MarkerDataDto } from './extHost.protocol.diagnostics.js';
import type {
  CodeLensDto, CodeLensListDto, ColorInformationDto, ColorPresentationDto, CompletionItemDto, DocumentHighlightDto, DocumentLinkDto,
  DocumentLinkListDto, DocumentSymbolDto, ExecutedCodeActionDto, ExtHostNavigationShape, FoldingRangeDto, InlayHintDto, InlayHintLabelPartDto,
  InlayHintListDto, LinkedEditingRangesDto, LocationDto, LocationLinkDto, MarkdownStringDto, ResolvedCompletionItemDto, SemanticTokensDto,
} from './extHost.protocol.languageFeatures.js';
import { CodeActionKind } from './extHostCommonTypes.js';
import { fromMarkerData, toMarkerData } from './extHostDiagnosticTypes.js';
import { Location, Selection, SnippetString, WorkspaceEdit } from './extHostEditorTypes.js';
import {
  completionItemKindFromDto, documentationToDto, InsertTextRule, isCommand, isRange, markdownFromDto, selectorToDto, textEditsToDto,
  workspaceEditToOperations,
} from './extHostLanguageConverters.js';
import type { CommandStore, ExtHostLanguageFeatures, LanguageFeatureGroup } from './extHostLanguageFeatures.js';
import { CodeActionAdapter, RenameAdapter } from './extHostLanguageFeaturesEdits.js';
import {
  CodeAction, CodeLens, Color, ColorInformation, ColorPresentation, CompletionItem, CompletionList, DocumentHighlight, DocumentHighlightKind,
  DocumentLink, DocumentSymbol, FoldingRange, FoldingRangeKind, Hover, InlayHint, InlayHintKind, InlayHintLabelPart, LinkedEditingRanges,
  SelectionRange, SemanticTokens, SemanticTokensBuilder, SemanticTokensEdit, SemanticTokensEdits, SemanticTokensLegend, SymbolInformation,
  SymbolKind, SymbolTag,
} from './extHostLanguageFeatureTypes.js';
import { positionFromEditor, positionToEditor, rangeFromEditor, rangeToEditor, textEditFromEditor } from './extHostTypeConverters.js';
import type { EditorPosition, EditorRange, EditorSelection, EditorTextEdit } from './extHostTypeConverters.js';

/*
 * The providers one reads and moves around a document with, on the extension host: document symbols,
 * links, definitions (and declarations, type definitions, implementations), references, highlights,
 * folding ranges, selection ranges, code lenses, colors, inlay hints, linked editing ranges and
 * semantic tokens; and the `vscode.execute*` API commands.
 *
 * Links, code lenses and inlay hints that can be resolved stay on the extension host under a list id
 * until the workbench releases the list (Monaco disposes it when it asks again or the editor goes);
 * the commands of a list live in its command store. A list asked for by a request that was cancelled is
 * never kept. A provider's change event (`onDidChangeCodeLenses` and the like) tells the workbench,
 * which fires the Monaco provider's own event so that Monaco asks again.
 *
 * The API commands run here, for the extension that calls them: they ask the workbench, which calls the
 * providers of every extension host for the document, and turn the answers into API values
 * (`DocumentSymbol`, `Location`, `Uri`...). A document the calling extension has not open gives an
 * empty answer: the command does not open it.
 */

class DocumentSymbolAdapter {
  constructor(readonly provider: vscode.DocumentSymbolProvider) {}
}

class DocumentLinkAdapter {
  constructor(readonly provider: vscode.DocumentLinkProvider) {}
}

class DefinitionAdapter {
  constructor(readonly provider: vscode.DefinitionProvider) {}
}

class DeclarationAdapter {
  constructor(readonly provider: vscode.DeclarationProvider) {}
}

class TypeDefinitionAdapter {
  constructor(readonly provider: vscode.TypeDefinitionProvider) {}
}

class ImplementationAdapter {
  constructor(readonly provider: vscode.ImplementationProvider) {}
}

class ReferenceAdapter {
  constructor(readonly provider: vscode.ReferenceProvider) {}
}

class DocumentHighlightAdapter {
  constructor(readonly provider: vscode.DocumentHighlightProvider) {}
}

class FoldingRangeAdapter {
  constructor(readonly provider: vscode.FoldingRangeProvider) {}
}

class SelectionRangeAdapter {
  constructor(readonly provider: vscode.SelectionRangeProvider) {}
}

class CodeLensAdapter {
  constructor(readonly provider: vscode.CodeLensProvider) {}
}

class ColorAdapter {
  constructor(readonly provider: vscode.DocumentColorProvider) {}
}

class InlayHintsAdapter {
  constructor(readonly provider: vscode.InlayHintsProvider) {}
}

class LinkedEditingRangeAdapter {
  constructor(readonly provider: vscode.LinkedEditingRangeProvider) {}
}

class DocumentSemanticTokensAdapter {
  constructor(readonly provider: vscode.DocumentSemanticTokensProvider) {}
}

/** Entries of one answer kept or sent; more are dropped. */
const MAX_ITEMS = 10_000;
/** Levels of a symbol tree; deeper symbols are dropped (the RPC refuses deeper values). */
const MAX_SYMBOL_DEPTH = 64;
/** Ranges of one selection range chain, and positions of one request. */
const MAX_CHAIN = 1000;
/** Strings of a semantic tokens legend. */
const MAX_LEGEND = 1024;

type ListKind = 'links' | 'lenses' | 'hints';

interface KeptList {
  readonly kind: ListKind;
  readonly handle: number;
  readonly extension: HostExtensionDescription;
  readonly items: unknown[];
  readonly commands?: CommandStore;
}

function checkProvider(provider: unknown, method: string): void {
  if (!provider || typeof (provider as Record<string, unknown>)[method] !== 'function') {
    throw new TypeError(`The provider has no '${method}' function.`);
  }
}

function isPosition(position: EditorPosition): boolean {
  return !!position && Number.isSafeInteger(position.lineNumber) && Number.isSafeInteger(position.column)
    && position.lineNumber >= 1 && position.column >= 1;
}

function documentPosition(document: vscode.TextDocument, position: EditorPosition): vscode.Position | undefined {
  return isPosition(position) ? document.validatePosition(positionFromEditor(position)) : undefined;
}

function documentRange(document: vscode.TextDocument, range: EditorRange): vscode.Range | undefined {
  if (!range || !isPosition({ lineNumber: range.startLineNumber, column: range.startColumn })
    || !isPosition({ lineNumber: range.endLineNumber, column: range.endColumn })) {
    return undefined;
  }
  return document.validateRange(rangeFromEditor(range));
}

/** Whether `outer` contains `inner`, for ranges of any shape the API takes. */
function containsRange(outer: vscode.Range, inner: vscode.Range): boolean {
  const before = (a: vscode.Position, b: vscode.Position) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  return before(outer.start, inner.start) && before(inner.end, outer.end);
}

function isUri(value: unknown): value is URI {
  return URI.isUri(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function tags(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.includes(SymbolTag.Deprecated) ? [SymbolTag.Deprecated] : undefined;
}

function symbolKind(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= SymbolKind.File && (value as number) <= SymbolKind.TypeParameter ? value as number : SymbolKind.Property;
}

/** A location as it crosses; another value gives undefined. */
function locationToDto(value: unknown): LocationDto | undefined {
  const location = value as vscode.Location | undefined;
  return location && typeof location === 'object' && isUri(location.uri) && isRange(location.range)
    ? { uri: location.uri as unknown as URI, range: rangeToEditor(location.range) } : undefined;
}

/** A definition (`Location`, `Location[]` or `LocationLink[]`) as links; entries of another shape are dropped. */
function definitionsToDto(value: unknown): LocationLinkDto[] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const result: LocationLinkDto[] = [];
  for (const entry of (Array.isArray(value) ? value : [value]).slice(0, MAX_ITEMS)) {
    const link = entry as vscode.LocationLink;
    if (link && typeof link === 'object' && isUri(link.targetUri) && isRange(link.targetRange)) {
      result.push({
        uri: link.targetUri as unknown as URI, range: rangeToEditor(link.targetRange),
        originSelectionRange: isRange(link.originSelectionRange) ? rangeToEditor(link.originSelectionRange) : undefined,
        targetSelectionRange: isRange(link.targetSelectionRange) ? rangeToEditor(link.targetSelectionRange) : undefined,
      });
    } else {
      const location = locationToDto(entry);
      if (location) {
        result.push(location);
      }
    }
  }
  return result;
}

function compareStart(a: EditorRange, b: EditorRange): number {
  return a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn;
}

function compareEnd(a: EditorRange, b: EditorRange): number {
  return a.endLineNumber - b.endLineNumber || a.endColumn - b.endColumn;
}

function containsEditorRange(outer: EditorRange, inner: EditorRange): boolean {
  return compareStart(outer, inner) <= 0 && compareEnd(inner, outer) <= 0;
}

/**
 * Symbol information as a tree, as VS Code builds it: sorted by start (the longer first), each symbol
 * goes under the last one that contains its range and is not the same range.
 */
function symbolInformationToTree(infos: readonly vscode.SymbolInformation[]): DocumentSymbolDto[] {
  const entries = infos.filter(info => info && typeof info === 'object' && isRange(info.location?.range)).slice(0, MAX_ITEMS)
    .map(info => {
      const range = rangeToEditor(info.location.range);
      return {
        name: typeof info.name === 'string' && info.name ? info.name : '!!MISSING: name!!',
        detail: '', kind: symbolKind(info.kind), tags: tags(info.tags), containerName: optionalString(info.containerName),
        range, selectionRange: range, children: [] as DocumentSymbolDto[],
      };
    })
    .sort((a, b) => compareStart(a.range, b.range) || compareEnd(b.range, a.range));
  const roots: DocumentSymbolDto[] = [];
  const parents: (typeof entries)[number][] = [];
  for (const entry of entries) {
    while (parents.length) {
      const parent = parents[parents.length - 1];
      if (containsEditorRange(parent.range, entry.range) && (compareStart(parent.range, entry.range) || compareEnd(parent.range, entry.range))
        && parents.length < MAX_SYMBOL_DEPTH) {
        break;
      }
      parents.pop();
    }
    (parents.length ? parents[parents.length - 1].children : roots).push(entry);
    parents.push(entry);
  }
  return roots;
}

/** Document symbols as they cross, children within their parent's depth; a symbol without a name or ranges is dropped. */
function documentSymbolsToDto(symbols: readonly vscode.DocumentSymbol[]): DocumentSymbolDto[] {
  let count = 0;
  const convert = (values: unknown, depth: number): DocumentSymbolDto[] => {
    const result: DocumentSymbolDto[] = [];
    if (!Array.isArray(values) || depth > MAX_SYMBOL_DEPTH) {
      return result;
    }
    for (const symbol of values as vscode.DocumentSymbol[]) {
      if (count >= MAX_ITEMS || !symbol || typeof symbol.name !== 'string' || !symbol.name || !isRange(symbol.range) || !isRange(symbol.selectionRange)) {
        continue;
      }
      count++;
      result.push({
        name: symbol.name, detail: typeof symbol.detail === 'string' ? symbol.detail : '', kind: symbolKind(symbol.kind), tags: tags(symbol.tags),
        range: rangeToEditor(symbol.range), selectionRange: rangeToEditor(symbol.selectionRange), children: convert(symbol.children, depth + 1),
      });
    }
    return result;
  };
  return convert(symbols, 1);
}

function colorToDto(color: vscode.Color) {
  return { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha };
}

function isColor(value: unknown): value is vscode.Color {
  const color = value as vscode.Color | undefined;
  return !!color && typeof color === 'object'
    && [color.red, color.green, color.blue, color.alpha].every(channel => typeof channel === 'number' && channel >= 0 && channel <= 1);
}

function textEditDto(edit: unknown): EditorTextEdit | undefined {
  return textEditsToDto([edit])?.[0];
}

/** A command as `vscode.executeCodeActionProvider` gives it back; arguments that cannot be copied are dropped. */
function commandToDto(command: vscode.Command | undefined): ExecutedCodeActionDto['command'] {
  if (!isCommand(command)) {
    return undefined;
  }
  let args: unknown[] | undefined = Array.isArray(command.arguments) ? command.arguments : undefined;
  try {
    structuredClone(args);
  } catch {
    args = undefined;
  }
  return { title: command.title, command: command.command, tooltip: optionalString(command.tooltip), arguments: args };
}

function semanticTokensData(value: unknown): Uint32Array | undefined {
  if (value instanceof Uint32Array) {
    return value;
  }
  return Array.isArray(value) && value.every(entry => Number.isInteger(entry) && entry >= 0) ? Uint32Array.from(value) : undefined;
}

/** A workspace edit from what crossed (`vscode.executeDocumentRenameProvider`, `executeCodeActionProvider`). */
function workspaceEditFromOperations(operations: readonly WorkspaceEditOperation[]): vscode.WorkspaceEdit {
  const edit = new WorkspaceEdit();
  for (const operation of operations) {
    switch (operation.kind) {
      case 'text':
        for (const { range, text } of operation.edit.operations) {
          edit.replace(operation.uri as unknown as vscode.Uri, rangeFromEditor(range), text ?? '');
        }
        break;
      case 'create':
        edit.createFile(operation.uri as unknown as vscode.Uri, { overwrite: operation.overwrite, ignoreIfExists: operation.ignoreIfExists, contents: operation.contents });
        break;
      case 'rename':
        edit.renameFile(operation.uri as unknown as vscode.Uri, operation.target as unknown as vscode.Uri, { overwrite: operation.overwrite, ignoreIfExists: operation.ignoreIfExists });
        break;
      case 'delete':
        edit.deleteFile(operation.uri as unknown as vscode.Uri, { recursive: operation.recursive, ignoreIfNotExists: operation.ignoreIfNotExists });
        break;
    }
  }
  return edit;
}

/**
 * What `vscode.executeDocumentSymbolProvider` gives: a `DocumentSymbol` that also carries the
 * `SymbolInformation` fields (`location`, `containerName`), as VS Code's merged result does.
 */
class ExecutedDocumentSymbol extends DocumentSymbol {
  containerName: string;
  location: vscode.Location;

  constructor(dto: DocumentSymbolDto, uri: vscode.Uri, containerName: string) {
    super(dto.name, dto.detail, dto.kind, rangeFromEditor(dto.range), rangeFromEditor(dto.selectionRange));
    this.tags = dto.tags?.length ? dto.tags as vscode.SymbolTag[] : undefined;
    this.containerName = containerName;
    this.location = new Location(uri, this.range);
    this.children = (dto.children ?? []).map(child => new ExecutedDocumentSymbol(child, uri, dto.name));
  }
}

function checkUriArgument(value: unknown): URI {
  if (!isUri(value)) {
    throw new TypeError('Expected a Uri.');
  }
  return value;
}

function checkPositionArgument(value: unknown): EditorPosition {
  const position = value as vscode.Position | undefined;
  if (!position || !Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) {
    throw new TypeError('Expected a Position.');
  }
  return positionToEditor(position);
}

function checkRangeArgument(value: unknown): vscode.Range {
  if (!isRange(value)) {
    throw new TypeError('Expected a Range.');
  }
  return value;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_ITEMS) : 0;
}

function formattingOptionsArgument(value: unknown) {
  const options = (value && typeof value === 'object' ? value : {}) as Partial<vscode.FormattingOptions>;
  return {
    tabSize: Number.isSafeInteger(options.tabSize) && options.tabSize! > 0 ? options.tabSize! : 4,
    insertSpaces: typeof options.insertSpaces === 'boolean' ? options.insertSpaces : true,
  };
}

function completionItemFromDto(dto: CompletionItemDto & ResolvedCompletionItemDto): vscode.CompletionItem {
  const label = typeof dto.label === 'string' ? dto.label : { label: dto.label.label, detail: dto.label.detail, description: dto.label.description };
  const item = new CompletionItem(label, completionItemKindFromDto(dto.kind));
  item.detail = dto.detail;
  item.documentation = markdownFromDto(dto.documentation);
  item.sortText = dto.sortText;
  item.filterText = dto.filterText;
  item.preselect = dto.preselect;
  item.insertText = (dto.insertTextRules ?? 0) & InsertTextRule.InsertAsSnippet ? new SnippetString(dto.insertText) : dto.insertText;
  item.keepWhitespace = ((dto.insertTextRules ?? 0) & InsertTextRule.KeepWhitespace) !== 0 || undefined;
  if (dto.range) {
    item.range = 'insert' in dto.range
      ? { inserting: rangeFromEditor(dto.range.insert), replacing: rangeFromEditor(dto.range.replace) } : rangeFromEditor(dto.range);
  }
  item.commitCharacters = dto.commitCharacters ? [...dto.commitCharacters] : undefined;
  item.additionalTextEdits = dto.additionalTextEdits?.map(textEditFromEditor);
  if (dto.tags?.length) {
    item.tags = [...dto.tags] as vscode.CompletionItemTag[];
  }
  return item;
}

function codeActionFromDto(dto: ExecutedCodeActionDto): vscode.CodeAction | vscode.Command {
  const command = dto.command && { title: dto.command.title, command: dto.command.command, tooltip: dto.command.tooltip, arguments: dto.command.arguments ? [...dto.command.arguments] : undefined };
  if (dto.isCommand && command) {
    return command;
  }
  const action = new CodeAction(dto.title, dto.kind !== undefined ? CodeActionKind.Empty.append(dto.kind) : undefined);
  action.isPreferred = dto.isPreferred;
  action.disabled = dto.disabled !== undefined ? { reason: dto.disabled } : undefined;
  action.command = command;
  action.edit = dto.edit ? workspaceEditFromOperations(dto.edit) : undefined;
  action.diagnostics = dto.diagnostics?.map(marker => fromMarkerData(marker as MarkerDataDto));
  return action;
}

export class ExtHostNavigation implements ExtHostNavigationShape, LanguageFeatureGroup {
  private readonly lists = new Map<number, KeptList>();
  private nextList = 0;
  private readonly apiCommands: { dispose(): void }[] = [];

  readonly types = {
    SymbolKind, SymbolTag, SymbolInformation, DocumentSymbol, DocumentLink, DocumentHighlight, DocumentHighlightKind, FoldingRange,
    FoldingRangeKind, SelectionRange, CodeLens, Color, ColorInformation, ColorPresentation, InlayHint, InlayHintKind, InlayHintLabelPart,
    LinkedEditingRanges, SemanticTokensLegend, SemanticTokens, SemanticTokensBuilder, SemanticTokensEdit, SemanticTokensEdits,
  };

  constructor(private readonly features: ExtHostLanguageFeatures) {
    this.registerApiCommands();
  }

  /** The link, code lens and inlay hint lists kept now, for tests that look for leaks. */
  get cacheSize(): number {
    return this.lists.size;
  }

  /**
   * Registers a provider: `event`, the provider's change event if it has one, tells the workbench for as
   * long as the registration lives.
   */
  private registerProvider(
    extension: HostExtensionDescription, adapter: object, event: vscode.Event<unknown> | undefined,
    register: (handle: number, hasEvent: boolean) => Promise<void>,
  ): vscode.Disposable {
    let listener: vscode.Disposable | undefined;
    const hasEvent = typeof event === 'function';
    const registration = this.features.register(extension, adapter, handle => {
      if (hasEvent) {
        listener = event(() => {
          void this.features.proxy.$emitProviderEvent(extension.key, handle).catch(() => {});
        });
      }
      return register(handle, hasEvent);
    });
    return { dispose: () => {
      listener?.dispose();
      registration.dispose();
    } } as vscode.Disposable;
  }

  api(extension: HostExtensionDescription) {
    const { features } = this;
    const proxy = features.proxy;
    const simple = <P>(method: string, kind: new (provider: P) => object, call: (handle: number, dto: ReturnType<typeof selectorToDto>) => Promise<void>) =>
      (selector: vscode.DocumentSelector, provider: P) => {
        checkProvider(provider, method);
        const dto = selectorToDto(selector);
        return features.register(extension, new kind(provider), handle => call(handle, dto));
      };
    return {
      registerDocumentSymbolProvider: (selector: vscode.DocumentSelector, provider: vscode.DocumentSymbolProvider, metaData?: vscode.DocumentSymbolProviderMetadata) => {
        checkProvider(provider, 'provideDocumentSymbols');
        const dto = selectorToDto(selector);
        const label = optionalString(metaData?.label);
        return features.register(extension, new DocumentSymbolAdapter(provider), handle => proxy.$registerDocumentSymbolSupport(extension.key, handle, dto, label));
      },
      registerDocumentLinkProvider: (selector: vscode.DocumentSelector, provider: vscode.DocumentLinkProvider) => {
        checkProvider(provider, 'provideDocumentLinks');
        const dto = selectorToDto(selector);
        const supportsResolve = typeof provider.resolveDocumentLink === 'function';
        return features.register(extension, new DocumentLinkAdapter(provider), handle => proxy.$registerDocumentLinkSupport(extension.key, handle, dto, supportsResolve));
      },
      registerDefinitionProvider: simple('provideDefinition', DefinitionAdapter, (handle, dto) => proxy.$registerDefinitionSupport(extension.key, handle, dto)),
      registerDeclarationProvider: simple('provideDeclaration', DeclarationAdapter, (handle, dto) => proxy.$registerDeclarationSupport(extension.key, handle, dto)),
      registerTypeDefinitionProvider: simple('provideTypeDefinition', TypeDefinitionAdapter, (handle, dto) => proxy.$registerTypeDefinitionSupport(extension.key, handle, dto)),
      registerImplementationProvider: simple('provideImplementation', ImplementationAdapter, (handle, dto) => proxy.$registerImplementationSupport(extension.key, handle, dto)),
      registerReferenceProvider: simple('provideReferences', ReferenceAdapter, (handle, dto) => proxy.$registerReferenceSupport(extension.key, handle, dto)),
      registerDocumentHighlightProvider: simple('provideDocumentHighlights', DocumentHighlightAdapter, (handle, dto) => proxy.$registerDocumentHighlightSupport(extension.key, handle, dto)),
      registerFoldingRangeProvider: (selector: vscode.DocumentSelector, provider: vscode.FoldingRangeProvider) => {
        checkProvider(provider, 'provideFoldingRanges');
        const dto = selectorToDto(selector);
        return this.registerProvider(extension, new FoldingRangeAdapter(provider), provider.onDidChangeFoldingRanges, (handle, hasEvent) =>
          proxy.$registerFoldingRangeSupport(extension.key, handle, dto, hasEvent));
      },
      registerSelectionRangeProvider: simple('provideSelectionRanges', SelectionRangeAdapter, (handle, dto) => proxy.$registerSelectionRangeSupport(extension.key, handle, dto)),
      registerCodeLensProvider: (selector: vscode.DocumentSelector, provider: vscode.CodeLensProvider) => {
        checkProvider(provider, 'provideCodeLenses');
        const dto = selectorToDto(selector);
        const supportsResolve = typeof provider.resolveCodeLens === 'function';
        return this.registerProvider(extension, new CodeLensAdapter(provider), provider.onDidChangeCodeLenses, (handle, hasEvent) =>
          proxy.$registerCodeLensSupport(extension.key, handle, dto, supportsResolve, hasEvent));
      },
      registerColorProvider: (selector: vscode.DocumentSelector, provider: vscode.DocumentColorProvider) => {
        checkProvider(provider, 'provideDocumentColors');
        checkProvider(provider, 'provideColorPresentations');
        const dto = selectorToDto(selector);
        return features.register(extension, new ColorAdapter(provider), handle => proxy.$registerColorSupport(extension.key, handle, dto));
      },
      registerInlayHintsProvider: (selector: vscode.DocumentSelector, provider: vscode.InlayHintsProvider) => {
        checkProvider(provider, 'provideInlayHints');
        const dto = selectorToDto(selector);
        const supportsResolve = typeof provider.resolveInlayHint === 'function';
        const name = typeof extension.manifest.displayName === 'string' && extension.manifest.displayName ? extension.manifest.displayName : extension.id;
        return this.registerProvider(extension, new InlayHintsAdapter(provider), provider.onDidChangeInlayHints, (handle, hasEvent) =>
          proxy.$registerInlayHintsSupport(extension.key, handle, dto, supportsResolve, hasEvent, name));
      },
      registerLinkedEditingRangeProvider: simple('provideLinkedEditingRanges', LinkedEditingRangeAdapter, (handle, dto) => proxy.$registerLinkedEditingRangeSupport(extension.key, handle, dto)),
      registerDocumentSemanticTokensProvider: (selector: vscode.DocumentSelector, provider: vscode.DocumentSemanticTokensProvider, legend: vscode.SemanticTokensLegend) => {
        checkProvider(provider, 'provideDocumentSemanticTokens');
        if (!legend || !Array.isArray(legend.tokenTypes) || !Array.isArray(legend.tokenModifiers ?? [])) {
          throw new TypeError('Expected a semantic tokens legend.');
        }
        const dto = selectorToDto(selector);
        const strings = (values: readonly unknown[]) => values.filter((value): value is string => typeof value === 'string').slice(0, MAX_LEGEND);
        const legendDto = { tokenTypes: strings(legend.tokenTypes), tokenModifiers: strings(legend.tokenModifiers ?? []) };
        return this.registerProvider(extension, new DocumentSemanticTokensAdapter(provider), provider.onDidChangeSemanticTokens, (handle, hasEvent) =>
          proxy.$registerDocumentSemanticTokensSupport(extension.key, handle, dto, legendDto, hasEvent));
      },
    } satisfies Pick<typeof vscode.languages, 'registerDocumentSymbolProvider' | 'registerDocumentLinkProvider' | 'registerDefinitionProvider'
      | 'registerDeclarationProvider' | 'registerTypeDefinitionProvider' | 'registerImplementationProvider' | 'registerReferenceProvider'
      | 'registerDocumentHighlightProvider' | 'registerFoldingRangeProvider' | 'registerSelectionRangeProvider' | 'registerCodeLensProvider'
      | 'registerColorProvider' | 'registerInlayHintsProvider' | 'registerLinkedEditingRangeProvider' | 'registerDocumentSemanticTokensProvider'>;
  }

  /** Asks the provider of `handle` about a document the extension may read: the fallback (undefined) otherwise. */
  private ask<A, R>(
    handle: number, kind: abstract new (...args: any[]) => A, uri: URI, token: CancellationToken,
    call: (adapter: A, document: vscode.TextDocument, extension: HostExtensionDescription) => R | undefined | PromiseLike<R | undefined>,
  ): Promise<R | undefined> {
    return this.features.invoke(handle, kind, token, undefined, (adapter, extension) => {
      const document = this.features.document(extension, uri);
      return document ? call(adapter, document, extension) : undefined;
    });
  }

  /** Keeps a list under a new id; nothing is kept for a request that was cancelled meanwhile. */
  private keep(token: CancellationToken, list: KeptList): number | undefined {
    if (token.isCancellationRequested || !this.features.adapter(list.handle, Object)) {
      list.commands?.dispose();
      return undefined;
    }
    const id = ++this.nextList;
    this.lists.set(id, list);
    return id;
  }

  private list(kind: ListKind, handle: number, id: number): KeptList | undefined {
    const list = Number.isSafeInteger(id) ? this.lists.get(id) : undefined;
    return list?.kind === kind && list.handle === handle ? list : undefined;
  }

  private drop(kind: ListKind, handle: number, id: number): void {
    const list = this.list(kind, handle, id);
    if (list) {
      this.lists.delete(id);
      list.commands?.dispose();
    }
  }

  // --- Document symbols ----------------------------------------------------------------------------

  $provideDocumentSymbols(handle: number, uri: URI, token: CancellationToken): Promise<DocumentSymbolDto[] | undefined> {
    return this.ask(handle, DocumentSymbolAdapter, uri, token, async (adapter, document) => {
      const value = await adapter.provider.provideDocumentSymbols(document, token as vscode.CancellationToken);
      if (!Array.isArray(value) || !value.length) {
        return undefined;
      }
      // As in VS Code: symbol information when the first entry is one (it has a location), otherwise a tree.
      return value[0] && typeof value[0] === 'object' && 'location' in value[0]
        ? symbolInformationToTree(value as vscode.SymbolInformation[])
        : documentSymbolsToDto(value as vscode.DocumentSymbol[]);
    });
  }

  // --- Links ---------------------------------------------------------------------------------------

  async $provideDocumentLinks(handle: number, uri: URI, token: CancellationToken): Promise<DocumentLinkListDto | undefined> {
    let built: { list: KeptList; links: DocumentLinkDto[] } | undefined;
    const links = await this.ask(handle, DocumentLinkAdapter, uri, token, async (adapter, document, extension) => {
      const value = await adapter.provider.provideDocumentLinks(document, token as vscode.CancellationToken);
      if (!Array.isArray(value) || token.isCancellationRequested) {
        return undefined;
      }
      const items = value.slice(0, MAX_ITEMS);
      const result: DocumentLinkDto[] = [];
      items.forEach((link, index) => {
        if (link && typeof link === 'object' && isRange(link.range)) {
          result.push({ range: rangeToEditor(link.range), url: isUri(link.target) ? link.target as unknown as URI : undefined, tooltip: optionalString(link.tooltip), index });
        }
      });
      if (result.some(link => !link.url) && typeof adapter.provider.resolveDocumentLink === 'function') {
        built = { list: { kind: 'links', handle, extension, items }, links: result };
      }
      return result;
    });
    if (!links) {
      return undefined;
    }
    const id = built?.links === links ? this.keep(token, built.list) : undefined;
    if (built?.links === links && id === undefined) {
      return undefined;
    }
    return { id, links };
  }

  $resolveDocumentLink(handle: number, id: number, index: number, token: CancellationToken): Promise<{ url?: URI; tooltip?: string } | undefined> {
    return this.features.invoke(handle, DocumentLinkAdapter, token, undefined, async adapter => {
      const list = this.list('links', handle, id);
      const link = list && Number.isSafeInteger(index) ? list.items[index] as vscode.DocumentLink | undefined : undefined;
      if (!list || !link || typeof adapter.provider.resolveDocumentLink !== 'function') {
        return undefined;
      }
      const resolved = await adapter.provider.resolveDocumentLink(link, token as vscode.CancellationToken) ?? link;
      if (token.isCancellationRequested || !resolved || typeof resolved !== 'object') {
        return undefined;
      }
      list.items[index] = resolved;
      return { url: isUri(resolved.target) ? resolved.target as unknown as URI : undefined, tooltip: optionalString(resolved.tooltip) };
    });
  }

  async $releaseDocumentLinks(handle: number, id: number): Promise<void> {
    this.drop('links', handle, id);
  }

  // --- Definitions and references ------------------------------------------------------------------

  private definitions<A>(handle: number, kind: abstract new (...args: any[]) => A, uri: URI, position: EditorPosition, token: CancellationToken,
    call: (adapter: A, document: vscode.TextDocument, at: vscode.Position) => unknown): Promise<LocationLinkDto[] | undefined> {
    return this.ask(handle, kind, uri, token, async (adapter, document) => {
      const at = documentPosition(document, position);
      return at ? definitionsToDto(await call(adapter, document, at)) : undefined;
    });
  }

  $provideDefinition(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<LocationLinkDto[] | undefined> {
    return this.definitions(handle, DefinitionAdapter, uri, position, token, (adapter, document, at) =>
      adapter.provider.provideDefinition(document, at, token as vscode.CancellationToken));
  }

  $provideDeclaration(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<LocationLinkDto[] | undefined> {
    return this.definitions(handle, DeclarationAdapter, uri, position, token, (adapter, document, at) =>
      adapter.provider.provideDeclaration(document, at, token as vscode.CancellationToken));
  }

  $provideTypeDefinition(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<LocationLinkDto[] | undefined> {
    return this.definitions(handle, TypeDefinitionAdapter, uri, position, token, (adapter, document, at) =>
      adapter.provider.provideTypeDefinition(document, at, token as vscode.CancellationToken));
  }

  $provideImplementation(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<LocationLinkDto[] | undefined> {
    return this.definitions(handle, ImplementationAdapter, uri, position, token, (adapter, document, at) =>
      adapter.provider.provideImplementation(document, at, token as vscode.CancellationToken));
  }

  $provideReferences(handle: number, uri: URI, position: EditorPosition, includeDeclaration: boolean, token: CancellationToken): Promise<LocationDto[] | undefined> {
    return this.ask(handle, ReferenceAdapter, uri, token, async (adapter, document) => {
      const at = documentPosition(document, position);
      const value = at && await adapter.provider.provideReferences(document, at, { includeDeclaration: includeDeclaration === true }, token as vscode.CancellationToken);
      return Array.isArray(value) ? value.slice(0, MAX_ITEMS).map(locationToDto).filter((location): location is LocationDto => !!location) : undefined;
    });
  }

  // --- Highlights, folding and selection ranges ------------------------------------------------------

  $provideDocumentHighlights(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<DocumentHighlightDto[] | undefined> {
    return this.ask(handle, DocumentHighlightAdapter, uri, token, async (adapter, document) => {
      const at = documentPosition(document, position);
      const value = at && await adapter.provider.provideDocumentHighlights(document, at, token as vscode.CancellationToken);
      return Array.isArray(value) ? value.slice(0, MAX_ITEMS).filter(highlight => highlight && isRange(highlight.range)).map(highlight => ({
        range: rangeToEditor(highlight.range),
        kind: highlight.kind === DocumentHighlightKind.Read || highlight.kind === DocumentHighlightKind.Write ? highlight.kind : DocumentHighlightKind.Text,
      })) : undefined;
    });
  }

  $provideFoldingRanges(handle: number, uri: URI, token: CancellationToken): Promise<FoldingRangeDto[] | undefined> {
    return this.ask(handle, FoldingRangeAdapter, uri, token, async (adapter, document) => {
      const value = await adapter.provider.provideFoldingRanges(document, {}, token as vscode.CancellationToken);
      if (!Array.isArray(value)) {
        return undefined;
      }
      // The API's lines are 0-based, Monaco's 1-based.
      return value.slice(0, MAX_ITEMS)
        .filter(range => range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.start <= range.end)
        .map(range => ({
          start: range.start + 1, end: range.end + 1,
          kind: range.kind === FoldingRangeKind.Comment || range.kind === FoldingRangeKind.Imports || range.kind === FoldingRangeKind.Region ? range.kind : undefined,
        }));
    });
  }

  $provideSelectionRanges(handle: number, uri: URI, positions: readonly EditorPosition[], token: CancellationToken): Promise<EditorRange[][] | undefined> {
    return this.ask(handle, SelectionRangeAdapter, uri, token, async (adapter, document) => {
      if (!Array.isArray(positions) || !positions.length || positions.length > MAX_CHAIN) {
        return undefined;
      }
      const at = positions.map(position => documentPosition(document, position));
      if (at.some(position => !position)) {
        return undefined;
      }
      const value = await adapter.provider.provideSelectionRanges(document, at as vscode.Position[], token as vscode.CancellationToken);
      if (!Array.isArray(value)) {
        return undefined;
      }
      if (value.length !== at.length) {
        throw new Error('BAD selection range, must have as many elements as positions');
      }
      return value.map(first => {
        const chain: EditorRange[] = [];
        let previous: vscode.Range | undefined;
        for (let range: vscode.SelectionRange | undefined = first; range && chain.length < MAX_CHAIN; range = range.parent) {
          if (!isRange(range.range) || (previous && !containsRange(range.range, previous))) {
            throw new Error('INVALID selection range, must contain the previous range');
          }
          chain.push(rangeToEditor(range.range));
          previous = range.range;
        }
        return chain;
      });
    });
  }

  // --- Code lenses ---------------------------------------------------------------------------------

  async $provideCodeLenses(handle: number, uri: URI, token: CancellationToken): Promise<CodeLensListDto | undefined> {
    let built: { list: KeptList; lenses: CodeLensDto[] } | undefined;
    const lenses = await this.ask(handle, CodeLensAdapter, uri, token, async (adapter, document, extension) => {
      const value = await adapter.provider.provideCodeLenses(document, token as vscode.CancellationToken);
      if (!Array.isArray(value) || token.isCancellationRequested) {
        return undefined;
      }
      const items = value.slice(0, MAX_ITEMS);
      const commands = this.features.createCommandStore(extension);
      const result: CodeLensDto[] = [];
      items.forEach((lens, index) => {
        if (lens && typeof lens === 'object' && isRange(lens.range)) {
          result.push({ index, range: rangeToEditor(lens.range), command: commands.toDto(lens.command) });
        }
      });
      built = { list: { kind: 'lenses', handle, extension, items, commands }, lenses: result };
      return result;
    });
    if (!lenses || built?.lenses !== lenses) {
      // Cancelled after the provider answered: nothing of it is kept.
      built?.list.commands?.dispose();
      return undefined;
    }
    const id = this.keep(token, built.list);
    return id === undefined ? undefined : { id, lenses };
  }

  $resolveCodeLens(handle: number, id: number, index: number, token: CancellationToken): Promise<CodeLensDto | undefined> {
    return this.features.invoke(handle, CodeLensAdapter, token, undefined, async adapter => {
      const list = this.list('lenses', handle, id);
      const lens = list && Number.isSafeInteger(index) ? list.items[index] as vscode.CodeLens | undefined : undefined;
      if (!list || !lens) {
        return undefined;
      }
      const resolved = typeof adapter.provider.resolveCodeLens === 'function'
        ? await adapter.provider.resolveCodeLens(lens, token as vscode.CancellationToken) ?? lens : lens;
      if (token.isCancellationRequested || !resolved || typeof resolved !== 'object' || this.list('lenses', handle, id) !== list) {
        return undefined;
      }
      list.items[index] = resolved;
      return { index, range: rangeToEditor(isRange(resolved.range) ? resolved.range : lens.range), command: list.commands!.toDto(resolved.command) };
    });
  }

  async $releaseCodeLenses(handle: number, id: number): Promise<void> {
    this.drop('lenses', handle, id);
  }

  // --- Colors --------------------------------------------------------------------------------------

  $provideDocumentColors(handle: number, uri: URI, token: CancellationToken): Promise<ColorInformationDto[] | undefined> {
    return this.ask(handle, ColorAdapter, uri, token, async (adapter, document) => {
      const value = await adapter.provider.provideDocumentColors(document, token as vscode.CancellationToken);
      return Array.isArray(value) ? value.slice(0, MAX_ITEMS).filter(info => info && isRange(info.range) && isColor(info.color))
        .map(info => ({ range: rangeToEditor(info.range), color: colorToDto(info.color) })) : undefined;
    });
  }

  $provideColorPresentations(handle: number, uri: URI, info: ColorInformationDto, token: CancellationToken): Promise<ColorPresentationDto[] | undefined> {
    return this.ask(handle, ColorAdapter, uri, token, async (adapter, document) => {
      const range = info && documentRange(document, info.range);
      if (!range || !isColor(info.color)) {
        return undefined;
      }
      const color = new Color(info.color.red, info.color.green, info.color.blue, info.color.alpha);
      const value = await adapter.provider.provideColorPresentations(color, { document, range }, token as vscode.CancellationToken);
      return Array.isArray(value) ? value.slice(0, MAX_ITEMS).filter(presentation => presentation && typeof presentation.label === 'string')
        .map(presentation => ({
          label: presentation.label, textEdit: textEditDto(presentation.textEdit), additionalTextEdits: textEditsToDto(presentation.additionalTextEdits),
        })) : undefined;
    });
  }

  // --- Inlay hints ---------------------------------------------------------------------------------

  private inlayHintToDto(hint: vscode.InlayHint, index: number, commands: CommandStore, range?: vscode.Range): InlayHintDto | undefined {
    if (!hint || typeof hint !== 'object' || !hint.position || !Number.isSafeInteger(hint.position.line) || !Number.isSafeInteger(hint.position.character)
      || (range && !range.contains(hint.position))) {
      return undefined;
    }
    let label: InlayHintDto['label'];
    if (typeof hint.label === 'string') {
      label = hint.label;
    } else if (Array.isArray(hint.label)) {
      label = hint.label.filter(part => part && typeof part.value === 'string').map((part): InlayHintLabelPartDto => ({
        label: part.value,
        tooltip: documentationToDto(part.tooltip),
        location: locationToDto(part.location),
        command: commands.toDto(part.command),
      }));
    } else {
      return undefined;
    }
    if (!label.length) {
      return undefined;
    }
    return {
      index, position: positionToEditor(hint.position), label,
      tooltip: documentationToDto(hint.tooltip) as string | MarkdownStringDto | undefined,
      kind: hint.kind === InlayHintKind.Type || hint.kind === InlayHintKind.Parameter ? hint.kind : undefined,
      textEdits: textEditsToDto(hint.textEdits),
      paddingLeft: hint.paddingLeft === true ? true : undefined,
      paddingRight: hint.paddingRight === true ? true : undefined,
    };
  }

  async $provideInlayHints(handle: number, uri: URI, range: EditorRange, token: CancellationToken): Promise<InlayHintListDto | undefined> {
    let built: { list: KeptList; hints: InlayHintDto[] } | undefined;
    const hints = await this.ask(handle, InlayHintsAdapter, uri, token, async (adapter, document, extension) => {
      const at = documentRange(document, range);
      const value = at && await adapter.provider.provideInlayHints(document, at, token as vscode.CancellationToken);
      if (!at || !Array.isArray(value) || token.isCancellationRequested) {
        return undefined;
      }
      const items = value.slice(0, MAX_ITEMS);
      const commands = this.features.createCommandStore(extension);
      const result: InlayHintDto[] = [];
      items.forEach((hint, index) => {
        const dto = this.inlayHintToDto(hint, index, commands, at);
        if (dto) {
          result.push(dto);
        }
      });
      built = { list: { kind: 'hints', handle, extension, items, commands }, hints: result };
      return result;
    });
    if (!hints || built?.hints !== hints) {
      // Cancelled after the provider answered: nothing of it is kept.
      built?.list.commands?.dispose();
      return undefined;
    }
    const id = this.keep(token, built.list);
    return id === undefined ? undefined : { id, hints };
  }

  $resolveInlayHint(handle: number, id: number, index: number, token: CancellationToken): Promise<InlayHintDto | undefined> {
    return this.features.invoke(handle, InlayHintsAdapter, token, undefined, async adapter => {
      const list = this.list('hints', handle, id);
      const hint = list && Number.isSafeInteger(index) ? list.items[index] as vscode.InlayHint | undefined : undefined;
      if (!list || !hint || typeof adapter.provider.resolveInlayHint !== 'function') {
        return undefined;
      }
      const resolved = await adapter.provider.resolveInlayHint(hint, token as vscode.CancellationToken) ?? hint;
      if (token.isCancellationRequested || this.list('hints', handle, id) !== list) {
        return undefined;
      }
      list.items[index] = resolved;
      // The position stays where the hint was shown.
      return this.inlayHintToDto({ ...resolved, position: hint.position } as vscode.InlayHint, index, list.commands!);
    });
  }

  async $releaseInlayHints(handle: number, id: number): Promise<void> {
    this.drop('hints', handle, id);
  }

  // --- Linked editing and semantic tokens --------------------------------------------------------------

  $provideLinkedEditingRanges(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<LinkedEditingRangesDto | undefined> {
    return this.ask(handle, LinkedEditingRangeAdapter, uri, token, async (adapter, document) => {
      const at = documentPosition(document, position);
      const value = at && await adapter.provider.provideLinkedEditingRanges(document, at, token as vscode.CancellationToken);
      if (!value || !Array.isArray(value.ranges)) {
        return undefined;
      }
      const pattern = value.wordPattern instanceof RegExp ? { source: value.wordPattern.source, flags: value.wordPattern.flags } : undefined;
      return { ranges: value.ranges.slice(0, MAX_ITEMS).filter(isRange).map(rangeToEditor), wordPattern: pattern };
    });
  }

  $provideDocumentSemanticTokens(handle: number, uri: URI, previousResultId: string | undefined, token: CancellationToken): Promise<SemanticTokensDto | undefined> {
    return this.ask(handle, DocumentSemanticTokensAdapter, uri, token, async (adapter, document) => {
      const { provider } = adapter;
      const value: vscode.SemanticTokens | vscode.SemanticTokensEdits | null | undefined = typeof previousResultId === 'string' && previousResultId
        && typeof provider.provideDocumentSemanticTokensEdits === 'function'
        ? await provider.provideDocumentSemanticTokensEdits(document, previousResultId, token as vscode.CancellationToken)
        : await provider.provideDocumentSemanticTokens(document, token as vscode.CancellationToken);
      if (!value || typeof value !== 'object') {
        return undefined;
      }
      const resultId = optionalString(value.resultId);
      if ('edits' in value && Array.isArray(value.edits)) {
        return {
          resultId,
          edits: value.edits.slice(0, MAX_ITEMS).filter(edit => edit && Number.isSafeInteger(edit.start) && Number.isSafeInteger(edit.deleteCount))
            .map(edit => ({ start: edit.start, deleteCount: edit.deleteCount, data: edit.data === undefined ? undefined : semanticTokensData(edit.data) })),
        };
      }
      const data = semanticTokensData((value as vscode.SemanticTokens).data);
      return data ? { resultId, data } : undefined;
    });
  }

  // --- For the API commands of other groups ----------------------------------------------------------

  $provideCodeActionsForCommand(handle: number, uri: URI, range: EditorRange | EditorSelection, kind: string | undefined, resolveCount: number, token: CancellationToken): Promise<ExecutedCodeActionDto[] | undefined> {
    return this.ask(handle, CodeActionAdapter, uri, token, async (adapter, document) => {
      const at = documentRange(document, range);
      if (!at) {
        return undefined;
      }
      const selection = range as Partial<EditorSelection>;
      const target = typeof selection.selectionStartLineNumber === 'number' && typeof selection.positionLineNumber === 'number'
        ? new Selection(document.validatePosition(positionFromEditor({ lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn! })),
          document.validatePosition(positionFromEditor({ lineNumber: selection.positionLineNumber, column: selection.positionColumn! })))
        : at;
      const only = typeof kind === 'string' && kind ? CodeActionKind.Empty.append(kind) : undefined;
      const value = await adapter.provider.provideCodeActions(document, target, { diagnostics: [], only, triggerKind: 1 }, token as vscode.CancellationToken);
      if (!Array.isArray(value)) {
        return undefined;
      }
      const result: ExecutedCodeActionDto[] = [];
      let resolved = 0;
      for (let item of value.slice(0, MAX_ITEMS)) {
        if (isCommand(item)) {
          result.push({ title: item.title, isCommand: true, command: commandToDto(item) });
          continue;
        }
        if (!item || typeof item !== 'object' || typeof item.title !== 'string') {
          continue;
        }
        if (!item.edit && resolved < count(resolveCount) && typeof adapter.provider.resolveCodeAction === 'function') {
          resolved++;
          item = await adapter.provider.resolveCodeAction(item, token as vscode.CancellationToken) ?? item;
        }
        const diagnostics = Array.isArray(item.diagnostics) ? item.diagnostics.flatMap(diagnostic => {
          try {
            return [toMarkerData(diagnostic)];
          } catch {
            return [];
          }
        }) : undefined;
        result.push({
          title: item.title,
          kind: typeof item.kind?.value === 'string' ? item.kind.value : undefined,
          isPreferred: item.isPreferred === true ? true : undefined,
          disabled: typeof item.disabled?.reason === 'string' ? item.disabled.reason : undefined,
          diagnostics,
          edit: item.edit ? await workspaceEditToOperations(item.edit, () => undefined) : undefined,
          command: commandToDto(item.command),
        });
      }
      return result;
    });
  }

  $provideRenameEditsForCommand(handle: number, uri: URI, position: EditorPosition, newName: string, token: CancellationToken): Promise<WorkspaceEditOperation[] | { readonly rejectReason: string } | undefined> {
    return this.ask(handle, RenameAdapter, uri, token, async (adapter, document): Promise<WorkspaceEditOperation[] | { readonly rejectReason: string } | undefined> => {
      const at = documentPosition(document, position);
      if (!at || typeof newName !== 'string') {
        return undefined;
      }
      let edit: vscode.WorkspaceEdit | null | undefined;
      try {
        edit = await adapter.provider.provideRenameEdits(document, at, newName, token as vscode.CancellationToken);
      } catch (error) {
        const reason = typeof error === 'string' ? error : error instanceof Error ? error.message : undefined;
        if (reason === undefined) {
          throw error;
        }
        return { rejectReason: reason };
      }
      return edit ? workspaceEditToOperations(edit, () => undefined) : undefined;
    });
  }

  async $navigationCacheSize(): Promise<number> {
    return this.lists.size;
  }

  // --- The API commands ------------------------------------------------------------------------------

  private registerApiCommands(): void {
    const { features } = this;
    const proxy = features.proxy;
    const open = (extension: string, value: unknown) => {
      const uri = checkUriArgument(value);
      return features.readable(extension, uri) ? uri : undefined;
    };
    const commands: Record<string, (extension: string, args: unknown[]) => Promise<unknown>> = {
      'vscode.executeDocumentSymbolProvider': async (extension, [value]) => {
        const uri = open(extension, value);
        const symbols = uri ? await proxy.$executeDocumentSymbolProvider(uri) : [];
        return symbols.length ? symbols.map(symbol => new ExecutedDocumentSymbol(symbol, uri as unknown as vscode.Uri, '')) : undefined;
      },
      'vscode.executeLinkProvider': async (extension, [value, resolveCount]) => {
        const uri = open(extension, value);
        const links = uri ? await proxy.$executeLinkProvider(uri, count(resolveCount)) : [];
        return links.map(link => {
          const result = new DocumentLink(rangeFromEditor(link.range), link.url as unknown as vscode.Uri | undefined);
          result.tooltip = link.tooltip;
          return result;
        });
      },
      'vscode.executeDefinitionProvider': async (extension, [value, position]) => {
        const at = checkPositionArgument(position);
        const uri = open(extension, value);
        const definitions = uri ? await proxy.$executeDefinitionProvider(uri, at) : [];
        // As in VS Code: a link when the provider gave one of the ranges only a link has.
        return definitions.map(definition => definition.originSelectionRange || definition.targetSelectionRange ? {
          targetUri: definition.uri as unknown as vscode.Uri, targetRange: rangeFromEditor(definition.range),
          originSelectionRange: definition.originSelectionRange && rangeFromEditor(definition.originSelectionRange),
          targetSelectionRange: definition.targetSelectionRange && rangeFromEditor(definition.targetSelectionRange),
        } satisfies vscode.LocationLink : new Location(definition.uri as unknown as vscode.Uri, rangeFromEditor(definition.range)));
      },
      'vscode.executeReferenceProvider': async (extension, [value, position]) => {
        const at = checkPositionArgument(position);
        const uri = open(extension, value);
        const references = uri ? await proxy.$executeReferenceProvider(uri, at) : [];
        return references.map(reference => new Location(reference.uri as unknown as vscode.Uri, rangeFromEditor(reference.range)));
      },
      'vscode.executeHoverProvider': async (extension, [value, position]) => {
        const at = checkPositionArgument(position);
        const uri = open(extension, value);
        const hovers = uri ? await proxy.$executeHoverProvider(uri, at) : [];
        return hovers.map(hover => new Hover(hover.contents.map(part => markdownFromDto(part) as vscode.MarkdownString), hover.range && rangeFromEditor(hover.range)));
      },
      'vscode.executeCompletionItemProvider': async (extension, [value, position, triggerCharacter, resolveCount]) => {
        const at = checkPositionArgument(position);
        const uri = open(extension, value);
        if (!uri) {
          return new CompletionList([], false);
        }
        const list = await proxy.$executeCompletionItemProvider(uri, at, optionalString(triggerCharacter), count(resolveCount));
        return new CompletionList(list.items.map(completionItemFromDto), list.incomplete);
      },
      'vscode.executeFormatDocumentProvider': async (extension, [value, options]) => {
        const uri = open(extension, value);
        const edits = uri && await proxy.$executeFormatDocumentProvider(uri, formattingOptionsArgument(options));
        return edits ? edits.map(textEditFromEditor) : undefined;
      },
      'vscode.executeFormatRangeProvider': async (extension, [value, range, options]) => {
        const at = rangeToEditor(checkRangeArgument(range));
        const uri = open(extension, value);
        const edits = uri && await proxy.$executeFormatRangeProvider(uri, at, formattingOptionsArgument(options));
        return edits ? edits.map(textEditFromEditor) : undefined;
      },
      'vscode.executeCodeActionProvider': async (extension, [value, range, kind, resolveCount]) => {
        const checked = checkRangeArgument(range);
        const at = checked instanceof Selection ? {
          ...rangeToEditor(checked),
          selectionStartLineNumber: checked.anchor.line + 1, selectionStartColumn: checked.anchor.character + 1,
          positionLineNumber: checked.active.line + 1, positionColumn: checked.active.character + 1,
        } : rangeToEditor(checked);
        const uri = open(extension, value);
        const actions = uri ? await proxy.$executeCodeActionProvider(uri, at, optionalString(kind), count(resolveCount)) : [];
        return actions.map(codeActionFromDto);
      },
      'vscode.executeDocumentRenameProvider': async (extension, [value, position, newName]) => {
        const at = checkPositionArgument(position);
        if (typeof newName !== 'string') {
          throw new TypeError('Expected a new name.');
        }
        const uri = open(extension, value);
        const result = uri && await proxy.$executeDocumentRenameProvider(uri, at, newName);
        if (result && 'rejectReason' in result) {
          throw new Error(result.rejectReason);
        }
        return result ? workspaceEditFromOperations(result) : undefined;
      },
    };
    for (const [id, handler] of Object.entries(commands)) {
      this.apiCommands.push(features.commands.registerApiCommand(id, handler));
    }
  }

  /** Forgets the lists of an extension that was released. */
  release(key: string): void {
    for (const [id, list] of [...this.lists]) {
      if (list.extension.key === key) {
        this.lists.delete(id);
        list.commands?.dispose();
      }
    }
  }

  dispose(): void {
    for (const list of this.lists.values()) {
      list.commands?.dispose();
    }
    this.lists.clear();
    for (const command of this.apiCommands.splice(0)) {
      command.dispose();
    }
  }
}

/** The group's factory; a function declaration, so the seam can list it while the two modules load each other. */
export function createNavigationGroup(features: ExtHostLanguageFeatures): ExtHostNavigation {
  return new ExtHostNavigation(features);
}
