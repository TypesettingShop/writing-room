import type { URI } from '../../../base/common/uri.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { WorkspaceEditOperation } from './extHost.protocol.documents.js';
import type { MarkerDataDto } from './extHost.protocol.diagnostics.js';
import type { EditorPosition, EditorRange, EditorSelection, EditorTextEdit } from './extHostTypeConverters.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

/*
 * Language features: extensions register providers with `languages.register*Provider`, and the
 * workbench registers a Monaco provider for each that asks the extension host. A call carries the
 * provider's handle, the document's URI and positions or ranges, never the text: the extension host
 * finds the document in its own copy. Positions and ranges are Monaco's: 1-based, the end column
 * exclusive. URIs cross as RPC URI values. The last argument of a `$provide*` call is the cancellation
 * token; cancelling it cancels the provider's token across the RPC.
 *
 * Each group of features adds its own section of shapes below; the area merges them into the two
 * shapes at the end.
 */

/** A relative pattern: `base` is the file system path of `baseUri`, which the score matches against. */
export interface RelativePatternDto {
  readonly base: string;
  readonly baseUri: URI;
  readonly pattern: string;
}

export interface LanguageFilterDto {
  readonly language?: string;
  readonly scheme?: string;
  readonly pattern?: string | RelativePatternDto;
  readonly notebookType?: string;
}

export type LanguageSelectorDto = string | LanguageFilterDto | ReadonlyArray<string | LanguageFilterDto>;

/** A regular expression, as source and flags: the workbench builds its own. */
export interface RegExpDto {
  readonly source: string;
  readonly flags: string;
}

export interface OnEnterRuleDto {
  readonly beforeText: RegExpDto;
  readonly afterText?: RegExpDto;
  readonly previousLineText?: RegExpDto;
  readonly action: { readonly indentAction: number; readonly appendText?: string; readonly removeText?: number };
}

export interface LanguageConfigurationDto {
  readonly comments?: { readonly lineComment?: string; readonly blockComment?: readonly [string, string] };
  readonly brackets?: ReadonlyArray<readonly [string, string]>;
  readonly wordPattern?: RegExpDto;
  readonly indentationRules?: {
    readonly decreaseIndentPattern: RegExpDto;
    readonly increaseIndentPattern: RegExpDto;
    readonly indentNextLinePattern?: RegExpDto;
    readonly unIndentedLinePattern?: RegExpDto;
  };
  readonly onEnterRules?: readonly OnEnterRuleDto[];
  readonly autoClosingPairs?: ReadonlyArray<{ readonly open: string; readonly close: string; readonly notIn?: readonly string[] }>;
}

/**
 * A command of a provider's result (a completion item's, a code lens's): the extension host keeps the
 * command and its arguments, which need not survive a copy, and the workbench runs it by `ref`.
 */
export interface CommandDto {
  readonly title: string;
  readonly tooltip?: string;
  readonly ref: number;
}

// --- The seam ------------------------------------------------------------------------------------

export interface MainThreadLanguageFeaturesSeamShape {
  /** Removes a registration of `extension`. A handle of another extension, or one already gone, is ignored. */
  $unregister(extension: string, handle: number): Promise<void>;
  /** Sets a language configuration of `extension` for `languageId`, until `$unregister(handle)`. */
  $setLanguageConfiguration(extension: string, handle: number, languageId: string, configuration: LanguageConfigurationDto): Promise<void>;
}

export interface ExtHostLanguageFeaturesSeamShape {
  /** Runs a command a provider's result held. A command that was released does nothing. */
  $executeProviderCommand(ref: number): Promise<void>;
}

// --- Completions, hover and signature help (wr-c9d8.w6j) ----------------------------------------

/** A markdown string as Monaco renders it. The workbench checks every field before Monaco sees it. */
export interface MarkdownStringDto {
  readonly value: string;
  readonly isTrusted?: boolean | { readonly enabledCommands: readonly string[] };
  readonly supportThemeIcons?: boolean;
  readonly supportHtml?: boolean;
  readonly baseUri?: URI;
}

export interface CompletionItemLabelDto {
  readonly label: string;
  readonly detail?: string;
  readonly description?: string;
}

/** Where an item goes: one range, or the range to insert into and the range to replace. */
export type CompletionRangeDto = EditorRange | { readonly insert: EditorRange; readonly replace: EditorRange };

/**
 * One item of a list. `kind`, `tags` and `insertTextRules` are Monaco's numbers. `index` names the item
 * in its list for resolving. An item without `range` takes the list's `defaults`.
 */
export interface CompletionItemDto {
  readonly index: number;
  readonly label: string | CompletionItemLabelDto;
  readonly kind: number;
  readonly tags?: readonly number[];
  readonly detail?: string;
  readonly documentation?: string | MarkdownStringDto;
  readonly sortText?: string;
  readonly filterText?: string;
  readonly preselect?: boolean;
  readonly insertText: string;
  readonly insertTextRules?: number;
  readonly range?: CompletionRangeDto;
  readonly commitCharacters?: readonly string[];
  readonly additionalTextEdits?: readonly EditorTextEdit[];
  readonly command?: CommandDto;
}

/**
 * A list the extension host keeps under `id` until `$releaseCompletionItems`: its items for resolving,
 * their commands for running. `defaults` is the word at the position, sent once per list.
 */
export interface CompletionListDto {
  readonly id: number;
  readonly incomplete?: boolean;
  readonly defaults: { readonly insert: EditorRange; readonly replace: EditorRange };
  readonly items: readonly CompletionItemDto[];
}

/** What resolving may fill in; the insert text and the range never change. */
export interface ResolvedCompletionItemDto {
  readonly detail?: string;
  readonly documentation?: string | MarkdownStringDto;
  readonly additionalTextEdits?: readonly EditorTextEdit[];
  readonly command?: CommandDto;
}

/** Monaco's trigger kind numbers, which are the API's. */
export interface CompletionContextDto {
  readonly triggerKind: number;
  readonly triggerCharacter?: string;
}

export interface HoverDto {
  readonly contents: readonly MarkdownStringDto[];
  readonly range?: EditorRange;
}

export interface ParameterInformationDto {
  readonly label: string | readonly [number, number];
  readonly documentation?: string | MarkdownStringDto;
}

export interface SignatureInformationDto {
  readonly label: string;
  readonly documentation?: string | MarkdownStringDto;
  readonly parameters: readonly ParameterInformationDto[];
  readonly activeParameter?: number;
}

export interface SignatureHelpDto {
  readonly signatures: readonly SignatureInformationDto[];
  readonly activeSignature: number;
  readonly activeParameter: number;
}

export interface SignatureHelpContextDto {
  readonly triggerKind: number;
  readonly triggerCharacter?: string;
  readonly isRetrigger: boolean;
  readonly activeSignatureHelp?: SignatureHelpDto;
}

export interface MainThreadCompletionsShape {
  $registerCompletionsSupport(extension: string, handle: number, selector: LanguageSelectorDto, triggerCharacters: readonly string[], supportsResolve: boolean): Promise<void>;
  $registerHoverSupport(extension: string, handle: number, selector: LanguageSelectorDto): Promise<void>;
  $registerSignatureHelpSupport(extension: string, handle: number, selector: LanguageSelectorDto, triggerCharacters: readonly string[], retriggerCharacters: readonly string[]): Promise<void>;
}

export interface ExtHostCompletionsShape {
  $provideCompletionItems(handle: number, uri: URI, position: EditorPosition, context: CompletionContextDto, token: CancellationToken): Promise<CompletionListDto | undefined>;
  $resolveCompletionItem(handle: number, id: number, index: number, token: CancellationToken): Promise<ResolvedCompletionItemDto | undefined>;
  /** Forgets a list: its items and their commands. */
  $releaseCompletionItems(handle: number, id: number): Promise<void>;
  /** How many lists the extension host keeps, for tests that look for leaks. */
  $completionCacheSize(): Promise<number>;
  $provideHover(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<HoverDto | undefined>;
  $provideSignatureHelp(handle: number, uri: URI, position: EditorPosition, context: SignatureHelpContextDto, token: CancellationToken): Promise<SignatureHelpDto | undefined>;
}

// --- Formatting, code actions and rename (wr-c9d8.08x) -------------------------------------------

/** The editor's formatting options: Monaco's tab size and whether to insert spaces. */
export interface FormattingOptionsDto {
  readonly tabSize: number;
  readonly insertSpaces: boolean;
}

/**
 * Formatting edits and the document version the provider read. Monaco applies them itself; the
 * workbench drops them when the model is no longer at that version.
 */
export interface FormattingEditsDto {
  readonly version: number;
  readonly edits: readonly EditorTextEdit[];
}

/** Monaco's code action context: the markers of the range, the kind asked for, the trigger (1 invoke, 2 auto). */
export interface CodeActionContextDto {
  readonly markers: readonly MarkerDataDto[];
  readonly only?: string;
  readonly trigger: number;
}

/**
 * One action of a list. It carries no edit and no command: applying it asks the extension host
 * (`$applyCodeAction`), which keeps the action under its list's `id` and `index`.
 */
export interface CodeActionDto {
  readonly index: number;
  readonly title: string;
  readonly kind?: string;
  readonly isPreferred?: boolean;
  /** Why the action cannot be applied now; Monaco shows it in place of the title. */
  readonly disabled?: string;
  readonly diagnostics?: readonly MarkerDataDto[];
}

/** A list the extension host keeps under `id` until `$releaseCodeActions`. */
export interface CodeActionListDto {
  readonly id: number;
  readonly actions: readonly CodeActionDto[];
}

export interface CodeActionProviderMetadataDto {
  readonly providedCodeActionKinds?: readonly string[];
  readonly documentation?: ReadonlyArray<{ readonly kind: string; readonly command: CommandDto }>;
}

/** Where a rename happens and the text the input starts with, or why the provider refused. */
export type RenameLocationDto = { readonly range: EditorRange; readonly text: string } | { readonly rejectReason: string };

/** What a rename did: the extension host applied the edit itself, or says why it did not. */
export type RenameResultDto = { readonly applied: true } | { readonly rejectReason: string };

export interface MainThreadEditsShape {
  $registerDocumentFormattingSupport(extension: string, handle: number, selector: LanguageSelectorDto, displayName: string): Promise<void>;
  $registerRangeFormattingSupport(extension: string, handle: number, selector: LanguageSelectorDto, displayName: string, supportsRanges: boolean): Promise<void>;
  $registerOnTypeFormattingSupport(extension: string, handle: number, selector: LanguageSelectorDto, triggerCharacters: readonly string[]): Promise<void>;
  $registerCodeActionSupport(extension: string, handle: number, selector: LanguageSelectorDto, metadata: CodeActionProviderMetadataDto): Promise<void>;
  $registerRenameSupport(extension: string, handle: number, selector: LanguageSelectorDto, supportsResolveLocation: boolean): Promise<void>;
}

export interface ExtHostEditsShape {
  $provideDocumentFormattingEdits(handle: number, uri: URI, options: FormattingOptionsDto, token: CancellationToken): Promise<FormattingEditsDto | undefined>;
  $provideDocumentRangeFormattingEdits(handle: number, uri: URI, range: EditorRange, options: FormattingOptionsDto, token: CancellationToken): Promise<FormattingEditsDto | undefined>;
  $provideDocumentRangesFormattingEdits(handle: number, uri: URI, ranges: readonly EditorRange[], options: FormattingOptionsDto, token: CancellationToken): Promise<FormattingEditsDto | undefined>;
  $provideOnTypeFormattingEdits(handle: number, uri: URI, position: EditorPosition, character: string, options: FormattingOptionsDto, token: CancellationToken): Promise<FormattingEditsDto | undefined>;
  $provideCodeActions(handle: number, uri: URI, rangeOrSelection: EditorRange | EditorSelection, context: CodeActionContextDto, token: CancellationToken): Promise<CodeActionListDto | undefined>;
  /**
   * Applies an action of a kept list: resolves it when it has no edit, applies its edit through the bulk
   * edit at the version the provider read, then runs its command. `true` when it did, `false` when the
   * edit was not applied (and the command not run), undefined when the list or the provider is gone.
   */
  $applyCodeAction(handle: number, id: number, index: number): Promise<boolean | undefined>;
  /** Forgets a list. */
  $releaseCodeActions(handle: number, id: number): Promise<void>;
  /** How many code action lists the extension host keeps, for tests that look for leaks. */
  $codeActionCacheSize(): Promise<number>;
  $resolveRenameLocation(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<RenameLocationDto | undefined>;
  /** Computes the rename's edit and applies it through the bulk edit; undefined when the provider gave none. */
  $provideRenameEdits(handle: number, uri: URI, position: EditorPosition, newName: string, token: CancellationToken): Promise<RenameResultDto | undefined>;
}

// --- Navigation: symbols, links, definitions, folding and the like (wr-c9d8.rj2) ----------------

/** A symbol of the document's tree. `kind` and `tags` are the API's numbers, which are Monaco's. */
export interface DocumentSymbolDto {
  readonly name: string;
  readonly detail: string;
  readonly kind: number;
  readonly tags?: readonly number[];
  readonly containerName?: string;
  readonly range: EditorRange;
  readonly selectionRange: EditorRange;
  readonly children?: readonly DocumentSymbolDto[];
}

export interface LocationDto {
  readonly uri: URI;
  readonly range: EditorRange;
}

/** A definition: a location, with the ranges a `LocationLink` adds when it is one. */
export interface LocationLinkDto extends LocationDto {
  readonly originSelectionRange?: EditorRange;
  readonly targetSelectionRange?: EditorRange;
}

/** A link of a list: `url` when the provider gave its target; `index` names it for resolving. */
export interface DocumentLinkDto {
  readonly range: EditorRange;
  readonly url?: URI;
  readonly tooltip?: string;
  readonly index: number;
}

/** Links; a list with links to resolve stays on the extension host under `id` until released. */
export interface DocumentLinkListDto {
  readonly id?: number;
  readonly links: readonly DocumentLinkDto[];
}

/** `kind` is the API's `DocumentHighlightKind`, which is Monaco's. */
export interface DocumentHighlightDto {
  readonly range: EditorRange;
  readonly kind: number;
}

/** Lines are 1-based, as Monaco's; `kind` is the API's `FoldingRangeKind` (1 comment, 2 imports, 3 region). */
export interface FoldingRangeDto {
  readonly start: number;
  readonly end: number;
  readonly kind?: number;
}

export interface CodeLensDto {
  readonly index: number;
  readonly range: EditorRange;
  readonly command?: CommandDto;
}

/** Code lenses the extension host keeps under `id` (for resolving and their commands) until released. */
export interface CodeLensListDto {
  readonly id: number;
  readonly lenses: readonly CodeLensDto[];
}

export interface ColorDto {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

export interface ColorInformationDto {
  readonly range: EditorRange;
  readonly color: ColorDto;
}

export interface ColorPresentationDto {
  readonly label: string;
  readonly textEdit?: EditorTextEdit;
  readonly additionalTextEdits?: readonly EditorTextEdit[];
}

export interface InlayHintLabelPartDto {
  readonly label: string;
  readonly tooltip?: string | MarkdownStringDto;
  readonly location?: LocationDto;
  readonly command?: CommandDto;
}

/** `kind` is the API's `InlayHintKind`, which is Monaco's. `index` names the hint for resolving. */
export interface InlayHintDto {
  readonly index: number;
  readonly position: EditorPosition;
  readonly label: string | readonly InlayHintLabelPartDto[];
  readonly tooltip?: string | MarkdownStringDto;
  readonly kind?: number;
  readonly textEdits?: readonly EditorTextEdit[];
  readonly paddingLeft?: boolean;
  readonly paddingRight?: boolean;
}

export interface InlayHintListDto {
  readonly id: number;
  readonly hints: readonly InlayHintDto[];
}

export interface LinkedEditingRangesDto {
  readonly ranges: readonly EditorRange[];
  readonly wordPattern?: RegExpDto;
}

export interface SemanticTokensLegendDto {
  readonly tokenTypes: readonly string[];
  readonly tokenModifiers: readonly string[];
}

/** Whole tokens, or edits of the tokens of `previousResultId`; Monaco applies the edits itself. */
export type SemanticTokensDto =
  | { readonly resultId?: string; readonly data: Uint32Array }
  | { readonly resultId?: string; readonly edits: ReadonlyArray<{ readonly start: number; readonly deleteCount: number; readonly data?: Uint32Array }> };

/** A code action as `vscode.executeCodeActionProvider` gives it: with its edit and its command. */
export interface ExecutedCodeActionDto {
  readonly title: string;
  /** Present for a plain `Command`. */
  readonly command?: { readonly title: string; readonly command: string; readonly tooltip?: string; readonly arguments?: readonly unknown[] };
  readonly isCommand?: boolean;
  readonly kind?: string;
  readonly isPreferred?: boolean;
  readonly disabled?: string;
  readonly diagnostics?: readonly MarkerDataDto[];
  readonly edit?: readonly WorkspaceEditOperation[];
}

export interface MainThreadNavigationShape {
  $registerDocumentSymbolSupport(extension: string, handle: number, selector: LanguageSelectorDto, label: string | undefined): Promise<void>;
  $registerDocumentLinkSupport(extension: string, handle: number, selector: LanguageSelectorDto, supportsResolve: boolean): Promise<void>;
  $registerDefinitionSupport(extension: string, handle: number, selector: LanguageSelectorDto): Promise<void>;
  $registerDeclarationSupport(extension: string, handle: number, selector: LanguageSelectorDto): Promise<void>;
  $registerTypeDefinitionSupport(extension: string, handle: number, selector: LanguageSelectorDto): Promise<void>;
  $registerImplementationSupport(extension: string, handle: number, selector: LanguageSelectorDto): Promise<void>;
  $registerReferenceSupport(extension: string, handle: number, selector: LanguageSelectorDto): Promise<void>;
  $registerDocumentHighlightSupport(extension: string, handle: number, selector: LanguageSelectorDto): Promise<void>;
  $registerFoldingRangeSupport(extension: string, handle: number, selector: LanguageSelectorDto, hasEvent: boolean): Promise<void>;
  $registerSelectionRangeSupport(extension: string, handle: number, selector: LanguageSelectorDto): Promise<void>;
  $registerCodeLensSupport(extension: string, handle: number, selector: LanguageSelectorDto, supportsResolve: boolean, hasEvent: boolean): Promise<void>;
  $registerColorSupport(extension: string, handle: number, selector: LanguageSelectorDto): Promise<void>;
  $registerInlayHintsSupport(extension: string, handle: number, selector: LanguageSelectorDto, supportsResolve: boolean, hasEvent: boolean, displayName: string): Promise<void>;
  $registerLinkedEditingRangeSupport(extension: string, handle: number, selector: LanguageSelectorDto): Promise<void>;
  $registerDocumentSemanticTokensSupport(extension: string, handle: number, selector: LanguageSelectorDto, legend: SemanticTokensLegendDto, hasEvent: boolean): Promise<void>;
  /** A provider's change event (code lenses, folding ranges, inlay hints, semantic tokens): Monaco asks again. */
  $emitProviderEvent(extension: string, handle: number): Promise<void>;

  // The `vscode.execute*` API commands: the providers of every extension host, as VS Code calls them.
  $executeDocumentSymbolProvider(uri: URI): Promise<DocumentSymbolDto[]>;
  $executeLinkProvider(uri: URI, resolveCount: number): Promise<{ range: EditorRange; url?: URI; tooltip?: string }[]>;
  $executeDefinitionProvider(uri: URI, position: EditorPosition): Promise<LocationLinkDto[]>;
  $executeReferenceProvider(uri: URI, position: EditorPosition): Promise<LocationDto[]>;
  $executeHoverProvider(uri: URI, position: EditorPosition): Promise<HoverDto[]>;
  $executeCompletionItemProvider(uri: URI, position: EditorPosition, triggerCharacter: string | undefined, resolveCount: number): Promise<{ incomplete: boolean; items: (CompletionItemDto & ResolvedCompletionItemDto)[] }>;
  $executeFormatDocumentProvider(uri: URI, options: FormattingOptionsDto): Promise<EditorTextEdit[] | undefined>;
  $executeFormatRangeProvider(uri: URI, range: EditorRange, options: FormattingOptionsDto): Promise<EditorTextEdit[] | undefined>;
  $executeCodeActionProvider(uri: URI, range: EditorRange | EditorSelection, kind: string | undefined, resolveCount: number): Promise<ExecutedCodeActionDto[]>;
  $executeDocumentRenameProvider(uri: URI, position: EditorPosition, newName: string): Promise<WorkspaceEditOperation[] | { readonly rejectReason: string } | undefined>;
}

export interface ExtHostNavigationShape {
  $provideDocumentSymbols(handle: number, uri: URI, token: CancellationToken): Promise<DocumentSymbolDto[] | undefined>;
  $provideDocumentLinks(handle: number, uri: URI, token: CancellationToken): Promise<DocumentLinkListDto | undefined>;
  $resolveDocumentLink(handle: number, id: number, index: number, token: CancellationToken): Promise<{ url?: URI; tooltip?: string } | undefined>;
  $releaseDocumentLinks(handle: number, id: number): Promise<void>;
  $provideDefinition(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<LocationLinkDto[] | undefined>;
  $provideDeclaration(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<LocationLinkDto[] | undefined>;
  $provideTypeDefinition(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<LocationLinkDto[] | undefined>;
  $provideImplementation(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<LocationLinkDto[] | undefined>;
  $provideReferences(handle: number, uri: URI, position: EditorPosition, includeDeclaration: boolean, token: CancellationToken): Promise<LocationDto[] | undefined>;
  $provideDocumentHighlights(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<DocumentHighlightDto[] | undefined>;
  $provideFoldingRanges(handle: number, uri: URI, token: CancellationToken): Promise<FoldingRangeDto[] | undefined>;
  /** For each position, its ranges from the innermost out. */
  $provideSelectionRanges(handle: number, uri: URI, positions: readonly EditorPosition[], token: CancellationToken): Promise<EditorRange[][] | undefined>;
  $provideCodeLenses(handle: number, uri: URI, token: CancellationToken): Promise<CodeLensListDto | undefined>;
  $resolveCodeLens(handle: number, id: number, index: number, token: CancellationToken): Promise<CodeLensDto | undefined>;
  $releaseCodeLenses(handle: number, id: number): Promise<void>;
  $provideDocumentColors(handle: number, uri: URI, token: CancellationToken): Promise<ColorInformationDto[] | undefined>;
  $provideColorPresentations(handle: number, uri: URI, color: ColorInformationDto, token: CancellationToken): Promise<ColorPresentationDto[] | undefined>;
  $provideInlayHints(handle: number, uri: URI, range: EditorRange, token: CancellationToken): Promise<InlayHintListDto | undefined>;
  $resolveInlayHint(handle: number, id: number, index: number, token: CancellationToken): Promise<InlayHintDto | undefined>;
  $releaseInlayHints(handle: number, id: number): Promise<void>;
  $provideLinkedEditingRanges(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<LinkedEditingRangesDto | undefined>;
  $provideDocumentSemanticTokens(handle: number, uri: URI, previousResultId: string | undefined, token: CancellationToken): Promise<SemanticTokensDto | undefined>;
  /** For `vscode.executeCodeActionProvider`: the actions with their edits, nothing kept. */
  $provideCodeActionsForCommand(handle: number, uri: URI, range: EditorRange | EditorSelection, kind: string | undefined, resolveCount: number, token: CancellationToken): Promise<ExecutedCodeActionDto[] | undefined>;
  /** For `vscode.executeDocumentRenameProvider`: the rename's edit, not applied. */
  $provideRenameEditsForCommand(handle: number, uri: URI, position: EditorPosition, newName: string, token: CancellationToken): Promise<WorkspaceEditOperation[] | { readonly rejectReason: string } | undefined>;
  /** How many link, code lens and inlay hint lists the extension host keeps, for tests that look for leaks. */
  $navigationCacheSize(): Promise<number>;
}

// --- The merged shapes ---------------------------------------------------------------------------

// --- Workspace symbols (wr-c9d8.qq0) --------------------------------------------------------------

/** A workspace symbol as it crosses. The range is Monaco's (1-based); `cacheId` finds the provider's own symbol to resolve. */
export interface WorkspaceSymbolDto {
  readonly name: string;
  readonly containerName?: string;
  /** VS Code's `SymbolKind` value. */
  readonly kind: number;
  readonly tags?: readonly number[];
  readonly location: { readonly uri: URI; readonly range?: EditorRange };
  /** The answer's id and the symbol's index in it. */
  readonly cacheId?: readonly [number, number];
}

export interface WorkspaceSymbolListDto {
  readonly id: number;
  readonly symbols: readonly WorkspaceSymbolDto[];
}

export interface MainThreadWorkspaceSymbolsShape {
  $registerNavigateTypeSupport(extension: string, handle: number, supportsResolve: boolean): Promise<void>;
  /** Every provider of every extension host, for `vscode.executeWorkspaceSymbolProvider`. */
  $executeWorkspaceSymbolProvider(query: string): Promise<WorkspaceSymbolDto[]>;
}

export interface ExtHostWorkspaceSymbolsShape {
  $provideWorkspaceSymbols(handle: number, query: string, token: CancellationToken): Promise<WorkspaceSymbolListDto | undefined>;
  $resolveWorkspaceSymbol(handle: number, symbol: WorkspaceSymbolDto, token: CancellationToken): Promise<WorkspaceSymbolDto | undefined>;
  $releaseWorkspaceSymbols(handle: number, id: number): Promise<void>;
  /** How many answers the extension host keeps, for tests that look for leaks. */
  $workspaceSymbolCacheSize(): Promise<number>;
}

export type MainThreadLanguageFeaturesShape = MainThreadLanguageFeaturesSeamShape & MainThreadCompletionsShape & MainThreadEditsShape
  & MainThreadNavigationShape & MainThreadWorkspaceSymbolsShape;

export type ExtHostLanguageFeaturesShape = ExtHostLanguageFeaturesSeamShape & ExtHostCompletionsShape & ExtHostEditsShape
  & ExtHostNavigationShape & ExtHostWorkspaceSymbolsShape;

/**
 * The `$` methods of every feature group, bound, under one object: each side answers under one RPC
 * identifier. Two groups may not share a name.
 */
export function mergeHandlers(groups: readonly object[]): Record<string, unknown> {
  const handlers: Record<string, unknown> = {};
  for (const group of groups) {
    const names = new Set<string>();
    for (let object: object | null = group; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
      for (const name of Object.getOwnPropertyNames(object)) {
        if (name.startsWith('$') && typeof (group as Record<string, unknown>)[name] === 'function') {
          names.add(name);
        }
      }
    }
    for (const name of names) {
      if (Object.hasOwn(handlers, name)) {
        throw new Error(`Language feature method '${name}' exists twice.`);
      }
      handlers[name] = ((group as Record<string, unknown>)[name] as (...args: unknown[]) => unknown).bind(group);
    }
  }
  return handlers;
}

export const MainThreadLanguageFeaturesProxy = createProxyIdentifier<MainThreadLanguageFeaturesShape>('MainThreadLanguageFeatures');
export const ExtHostLanguageFeaturesProxy = createProxyIdentifier<ExtHostLanguageFeaturesShape>('ExtHostLanguageFeatures');
