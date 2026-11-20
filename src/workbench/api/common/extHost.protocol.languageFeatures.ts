import type { URI } from '../../../base/common/uri.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
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

// --- The merged shapes ---------------------------------------------------------------------------

export type MainThreadLanguageFeaturesShape = MainThreadLanguageFeaturesSeamShape & MainThreadCompletionsShape & MainThreadEditsShape;

export type ExtHostLanguageFeaturesShape = ExtHostLanguageFeaturesSeamShape & ExtHostCompletionsShape & ExtHostEditsShape;

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
