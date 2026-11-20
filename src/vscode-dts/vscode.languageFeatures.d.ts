declare module 'vscode' {
  // Language features (wr-c9d8). The seam: document selectors, `languages.match` and language configurations.
  // `GlobPattern` is declared here until the file system area's declaration (wr-8a5f) is merged.

  export type GlobPattern = string | RelativePattern;

  export interface DocumentFilter {
    readonly language?: string;
    readonly notebookType?: string;
    readonly scheme?: string;
    readonly pattern?: GlobPattern;
  }

  export type DocumentSelector = DocumentFilter | string | ReadonlyArray<DocumentFilter | string>;

  export interface CommentRule {
    lineComment?: string | LineCommentRule;
    blockComment?: CharacterPair;
  }

  export interface LineCommentRule {
    comment: string;
    noIndent?: boolean;
  }

  export type CharacterPair = [
    string,
    string
  ];

  export interface IndentationRule {
    decreaseIndentPattern: RegExp;
    increaseIndentPattern: RegExp;
    indentNextLinePattern?: RegExp;
    unIndentedLinePattern?: RegExp;
  }

  export enum IndentAction {
    None = 0,
    Indent = 1,
    IndentOutdent = 2,
    Outdent = 3
  }

  export interface EnterAction {
    indentAction: IndentAction;
    appendText?: string;
    removeText?: number;
  }

  export interface OnEnterRule {
    beforeText: RegExp;
    afterText?: RegExp;
    previousLineText?: RegExp;
    action: EnterAction;
  }

  export enum SyntaxTokenType {
    Other = 0,
    Comment = 1,
    String = 2,
    RegEx = 3
  }

  export interface AutoClosingPair {
    open: string;
    close: string;
    notIn?: SyntaxTokenType[];
  }

  export interface LanguageConfiguration {
    comments?: CommentRule;
    brackets?: CharacterPair[];
    wordPattern?: RegExp;
    indentationRules?: IndentationRule;
    onEnterRules?: OnEnterRule[];
    autoClosingPairs?: AutoClosingPair[];
    __electricCharacterSupport?: {
      brackets?: any;
      docComment?: {
        scope: string;
        open: string;
        lineStart: string;
        close?: string;
      };
    };
    __characterPairSupport?: {
      autoClosingPairs: {
        open: string;
        close: string;
        notIn?: string[];
      }[];
    };
  }

  // Completions, hover and signature help (wr-c9d8.w6j).

  export enum CompletionItemKind {
    Text = 0,
    Method = 1,
    Function = 2,
    Constructor = 3,
    Field = 4,
    Variable = 5,
    Class = 6,
    Interface = 7,
    Module = 8,
    Property = 9,
    Unit = 10,
    Value = 11,
    Enum = 12,
    Keyword = 13,
    Snippet = 14,
    Color = 15,
    File = 16,
    Reference = 17,
    Folder = 18,
    EnumMember = 19,
    Constant = 20,
    Struct = 21,
    Event = 22,
    Operator = 23,
    TypeParameter = 24,
    User = 25,
    Issue = 26
  }

  export enum CompletionItemTag {
    Deprecated = 1
  }

  export interface CompletionItemLabel {
    label: string;
    detail?: string;
    description?: string;
  }

  export class CompletionItem {
    label: string | CompletionItemLabel;
    kind?: CompletionItemKind;
    tags?: readonly CompletionItemTag[];
    detail?: string;
    documentation?: string | MarkdownString;
    sortText?: string;
    filterText?: string;
    preselect?: boolean;
    insertText?: string | SnippetString;
    range?: Range | {
      inserting: Range;
      replacing: Range;
    };
    commitCharacters?: string[];
    keepWhitespace?: boolean;
    textEdit?: TextEdit;
    additionalTextEdits?: TextEdit[];
    command?: Command;
    constructor(label: string | CompletionItemLabel, kind?: CompletionItemKind);
  }

  export class CompletionList<T extends CompletionItem = CompletionItem> {
    isIncomplete?: boolean;
    items: T[];
    constructor(items?: T[], isIncomplete?: boolean);
  }

  export enum CompletionTriggerKind {
    Invoke = 0,
    TriggerCharacter = 1,
    TriggerForIncompleteCompletions = 2
  }

  export interface CompletionContext {
    readonly triggerKind: CompletionTriggerKind;
    readonly triggerCharacter: string | undefined;
  }

  export interface CompletionItemProvider<T extends CompletionItem = CompletionItem> {
    provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken, context: CompletionContext): ProviderResult<T[] | CompletionList<T>>;
    resolveCompletionItem?(item: T, token: CancellationToken): ProviderResult<T>;
  }

  export class Hover {
    contents: Array<MarkdownString | MarkedString>;
    range?: Range;
    constructor(contents: MarkdownString | MarkedString | Array<MarkdownString | MarkedString>, range?: Range);
  }

  export interface HoverProvider {
    provideHover(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Hover>;
  }

  export enum SignatureHelpTriggerKind {
    Invoke = 1,
    TriggerCharacter = 2,
    ContentChange = 3
  }

  export interface SignatureHelpContext {
    readonly triggerKind: SignatureHelpTriggerKind;
    readonly triggerCharacter: string | undefined;
    readonly isRetrigger: boolean;
    readonly activeSignatureHelp: SignatureHelp | undefined;
  }

  export class SignatureHelp {
    signatures: SignatureInformation[];
    activeSignature: number;
    activeParameter: number;
  }

  export class SignatureInformation {
    label: string;
    documentation?: string | MarkdownString;
    parameters: ParameterInformation[];
    activeParameter?: number;
    constructor(label: string, documentation?: string | MarkdownString);
  }

  export class ParameterInformation {
    label: string | [
      number,
      number
    ];
    documentation?: string | MarkdownString;
    constructor(label: string | [
      number,
      number
    ], documentation?: string | MarkdownString);
  }

  export interface SignatureHelpProvider {
    provideSignatureHelp(document: TextDocument, position: Position, token: CancellationToken, context: SignatureHelpContext): ProviderResult<SignatureHelp>;
  }

  export interface SignatureHelpProviderMetadata {
    readonly triggerCharacters: readonly string[];
    readonly retriggerCharacters: readonly string[];
  }

  // Formatting, code actions and rename (wr-c9d8.08x).

  export interface FormattingOptions {
    tabSize: number;
    insertSpaces: boolean;
    [key: string]: boolean | number | string;
  }

  export interface DocumentFormattingEditProvider {
    provideDocumentFormattingEdits(document: TextDocument, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
  }

  export interface DocumentRangeFormattingEditProvider {
    provideDocumentRangeFormattingEdits(document: TextDocument, range: Range, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
    provideDocumentRangesFormattingEdits?(document: TextDocument, ranges: Range[], options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
  }

  export interface OnTypeFormattingEditProvider {
    provideOnTypeFormattingEdits(document: TextDocument, position: Position, ch: string, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
  }

  export class CodeAction {
    title: string;
    edit?: WorkspaceEdit;
    diagnostics?: Diagnostic[];
    command?: Command;
    kind?: CodeActionKind;
    isPreferred?: boolean;
    disabled?: {
      readonly reason: string;
    };
    constructor(title: string, kind?: CodeActionKind);
  }

  export enum CodeActionTriggerKind {
    Invoke = 1,
    Automatic = 2
  }

  export interface CodeActionContext {
    readonly triggerKind: CodeActionTriggerKind;
    readonly diagnostics: readonly Diagnostic[];
    readonly only: CodeActionKind | undefined;
  }

  export interface CodeActionProvider<T extends CodeAction = CodeAction> {
    provideCodeActions(document: TextDocument, range: Range | Selection, context: CodeActionContext, token: CancellationToken): ProviderResult<Array<Command | T>>;
    resolveCodeAction?(codeAction: T, token: CancellationToken): ProviderResult<T>;
  }

  export interface CodeActionProviderMetadata {
    readonly providedCodeActionKinds?: readonly CodeActionKind[];
    readonly documentation?: ReadonlyArray<{
      readonly kind: CodeActionKind;
      readonly command: Command;
    }>;
  }

  export interface RenameProvider {
    provideRenameEdits(document: TextDocument, position: Position, newName: string, token: CancellationToken): ProviderResult<WorkspaceEdit>;
    prepareRename?(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Range | {
      range: Range;
      placeholder: string;
    }>;
  }

  // Navigation: symbols, links, definitions, folding and the like (wr-c9d8.rj2).

  export enum SymbolKind {
    File = 0,
    Module = 1,
    Namespace = 2,
    Package = 3,
    Class = 4,
    Method = 5,
    Property = 6,
    Field = 7,
    Constructor = 8,
    Enum = 9,
    Interface = 10,
    Function = 11,
    Variable = 12,
    Constant = 13,
    String = 14,
    Number = 15,
    Boolean = 16,
    Array = 17,
    Object = 18,
    Key = 19,
    Null = 20,
    EnumMember = 21,
    Struct = 22,
    Event = 23,
    Operator = 24,
    TypeParameter = 25
  }

  export enum SymbolTag {
    Deprecated = 1
  }

  export class SymbolInformation {
    name: string;
    containerName: string;
    kind: SymbolKind;
    tags?: readonly SymbolTag[];
    location: Location;
    constructor(name: string, kind: SymbolKind, containerName: string, location: Location);
    constructor(name: string, kind: SymbolKind, range: Range, uri?: Uri, containerName?: string);
  }

  export class DocumentSymbol {
    name: string;
    detail: string;
    kind: SymbolKind;
    tags?: readonly SymbolTag[];
    range: Range;
    selectionRange: Range;
    children: DocumentSymbol[];
    constructor(name: string, detail: string, kind: SymbolKind, range: Range, selectionRange: Range);
  }

  export interface DocumentSymbolProvider {
    provideDocumentSymbols(document: TextDocument, token: CancellationToken): ProviderResult<SymbolInformation[] | DocumentSymbol[]>;
  }

  export interface DocumentSymbolProviderMetadata {
    label?: string;
  }

  export class DocumentLink {
    range: Range;
    target?: Uri;
    tooltip?: string;
    constructor(range: Range, target?: Uri);
  }

  export interface DocumentLinkProvider<T extends DocumentLink = DocumentLink> {
    provideDocumentLinks(document: TextDocument, token: CancellationToken): ProviderResult<T[]>;
    resolveDocumentLink?(link: T, token: CancellationToken): ProviderResult<T>;
  }

  export interface LocationLink {
    originSelectionRange?: Range;
    targetUri: Uri;
    targetRange: Range;
    targetSelectionRange?: Range;
  }

  export type DefinitionLink = LocationLink;

  export type Definition = Location | Location[];

  export interface DefinitionProvider {
    provideDefinition(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Definition | DefinitionLink[]>;
  }

  export type Declaration = Location | Location[] | LocationLink[];

  export interface DeclarationProvider {
    provideDeclaration(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Declaration>;
  }

  export interface TypeDefinitionProvider {
    provideTypeDefinition(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Definition | DefinitionLink[]>;
  }

  export interface ImplementationProvider {
    provideImplementation(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Definition | DefinitionLink[]>;
  }

  export interface ReferenceContext {
    readonly includeDeclaration: boolean;
  }

  export interface ReferenceProvider {
    provideReferences(document: TextDocument, position: Position, context: ReferenceContext, token: CancellationToken): ProviderResult<Location[]>;
  }

  export enum DocumentHighlightKind {
    Text = 0,
    Read = 1,
    Write = 2
  }

  export class DocumentHighlight {
    range: Range;
    kind?: DocumentHighlightKind;
    constructor(range: Range, kind?: DocumentHighlightKind);
  }

  export interface DocumentHighlightProvider {
    provideDocumentHighlights(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<DocumentHighlight[]>;
  }

  export enum FoldingRangeKind {
    Comment = 1,
    Imports = 2,
    Region = 3
  }

  export class FoldingRange {
    start: number;
    end: number;
    kind?: FoldingRangeKind;
    constructor(start: number, end: number, kind?: FoldingRangeKind);
  }

  export interface FoldingContext {
  }

  export interface FoldingRangeProvider {
    onDidChangeFoldingRanges?: Event<void>;
    provideFoldingRanges(document: TextDocument, context: FoldingContext, token: CancellationToken): ProviderResult<FoldingRange[]>;
  }

  export class SelectionRange {
    range: Range;
    parent?: SelectionRange;
    constructor(range: Range, parent?: SelectionRange);
  }

  export interface SelectionRangeProvider {
    provideSelectionRanges(document: TextDocument, positions: readonly Position[], token: CancellationToken): ProviderResult<SelectionRange[]>;
  }

  export class CodeLens {
    range: Range;
    command?: Command;
    readonly isResolved: boolean;
    constructor(range: Range, command?: Command);
  }

  export interface CodeLensProvider<T extends CodeLens = CodeLens> {
    onDidChangeCodeLenses?: Event<void>;
    provideCodeLenses(document: TextDocument, token: CancellationToken): ProviderResult<T[]>;
    resolveCodeLens?(codeLens: T, token: CancellationToken): ProviderResult<T>;
  }

  export class Color {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
    readonly alpha: number;
    constructor(red: number, green: number, blue: number, alpha: number);
  }

  export class ColorInformation {
    range: Range;
    color: Color;
    constructor(range: Range, color: Color);
  }

  export class ColorPresentation {
    label: string;
    textEdit?: TextEdit;
    additionalTextEdits?: TextEdit[];
    constructor(label: string);
  }

  export interface DocumentColorProvider {
    provideDocumentColors(document: TextDocument, token: CancellationToken): ProviderResult<ColorInformation[]>;
    provideColorPresentations(color: Color, context: {
      readonly document: TextDocument;
      readonly range: Range;
    }, token: CancellationToken): ProviderResult<ColorPresentation[]>;
  }

  export enum InlayHintKind {
    Type = 1,
    Parameter = 2
  }

  export class InlayHintLabelPart {
    value: string;
    tooltip?: string | MarkdownString | undefined;
    location?: Location | undefined;
    command?: Command | undefined;
    constructor(value: string);
  }

  export class InlayHint {
    position: Position;
    label: string | InlayHintLabelPart[];
    tooltip?: string | MarkdownString | undefined;
    kind?: InlayHintKind;
    textEdits?: TextEdit[];
    paddingLeft?: boolean;
    paddingRight?: boolean;
    constructor(position: Position, label: string | InlayHintLabelPart[], kind?: InlayHintKind);
  }

  export interface InlayHintsProvider<T extends InlayHint = InlayHint> {
    onDidChangeInlayHints?: Event<void>;
    provideInlayHints(document: TextDocument, range: Range, token: CancellationToken): ProviderResult<T[]>;
    resolveInlayHint?(hint: T, token: CancellationToken): ProviderResult<T>;
  }

  export class LinkedEditingRanges {
    constructor(ranges: Range[], wordPattern?: RegExp);
    readonly ranges: Range[];
    readonly wordPattern: RegExp | undefined;
  }

  export interface LinkedEditingRangeProvider {
    provideLinkedEditingRanges(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<LinkedEditingRanges>;
  }

  export class SemanticTokensLegend {
    readonly tokenTypes: string[];
    readonly tokenModifiers: string[];
    constructor(tokenTypes: string[], tokenModifiers?: string[]);
  }

  export class SemanticTokensBuilder {
    constructor(legend?: SemanticTokensLegend);
    push(line: number, char: number, length: number, tokenType: number, tokenModifiers?: number): void;
    push(range: Range, tokenType: string, tokenModifiers?: readonly string[]): void;
    build(resultId?: string): SemanticTokens;
  }

  export class SemanticTokens {
    readonly resultId: string | undefined;
    readonly data: Uint32Array;
    constructor(data: Uint32Array, resultId?: string);
  }

  export class SemanticTokensEdits {
    readonly resultId: string | undefined;
    readonly edits: SemanticTokensEdit[];
    constructor(edits: SemanticTokensEdit[], resultId?: string);
  }

  export class SemanticTokensEdit {
    readonly start: number;
    readonly deleteCount: number;
    readonly data: Uint32Array | undefined;
    constructor(start: number, deleteCount: number, data?: Uint32Array);
  }

  export interface DocumentSemanticTokensProvider {
    onDidChangeSemanticTokens?: Event<void>;
    provideDocumentSemanticTokens(document: TextDocument, token: CancellationToken): ProviderResult<SemanticTokens>;
    provideDocumentSemanticTokensEdits?(document: TextDocument, previousResultId: string, token: CancellationToken): ProviderResult<SemanticTokens | SemanticTokensEdits>;
  }

  export namespace languages {
    export function match(selector: DocumentSelector, document: TextDocument): number;
    export function setLanguageConfiguration(language: string, configuration: LanguageConfiguration): Disposable;
    export function registerCompletionItemProvider(selector: DocumentSelector, provider: CompletionItemProvider, ...triggerCharacters: string[]): Disposable;
    export function registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): Disposable;
    export function registerSignatureHelpProvider(selector: DocumentSelector, provider: SignatureHelpProvider, ...triggerCharacters: string[]): Disposable;
    export function registerSignatureHelpProvider(selector: DocumentSelector, provider: SignatureHelpProvider, metadata: SignatureHelpProviderMetadata): Disposable;
    export function registerDocumentFormattingEditProvider(selector: DocumentSelector, provider: DocumentFormattingEditProvider): Disposable;
    export function registerDocumentRangeFormattingEditProvider(selector: DocumentSelector, provider: DocumentRangeFormattingEditProvider): Disposable;
    export function registerOnTypeFormattingEditProvider(selector: DocumentSelector, provider: OnTypeFormattingEditProvider, firstTriggerCharacter: string, ...moreTriggerCharacter: string[]): Disposable;
    export function registerCodeActionsProvider(selector: DocumentSelector, provider: CodeActionProvider, metadata?: CodeActionProviderMetadata): Disposable;
    export function registerRenameProvider(selector: DocumentSelector, provider: RenameProvider): Disposable;
    export function registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable;
    export function registerDefinitionProvider(selector: DocumentSelector, provider: DefinitionProvider): Disposable;
    export function registerImplementationProvider(selector: DocumentSelector, provider: ImplementationProvider): Disposable;
    export function registerTypeDefinitionProvider(selector: DocumentSelector, provider: TypeDefinitionProvider): Disposable;
    export function registerDeclarationProvider(selector: DocumentSelector, provider: DeclarationProvider): Disposable;
    export function registerDocumentHighlightProvider(selector: DocumentSelector, provider: DocumentHighlightProvider): Disposable;
    export function registerDocumentSymbolProvider(selector: DocumentSelector, provider: DocumentSymbolProvider, metaData?: DocumentSymbolProviderMetadata): Disposable;
    export function registerReferenceProvider(selector: DocumentSelector, provider: ReferenceProvider): Disposable;
    export function registerDocumentSemanticTokensProvider(selector: DocumentSelector, provider: DocumentSemanticTokensProvider, legend: SemanticTokensLegend): Disposable;
    export function registerDocumentLinkProvider(selector: DocumentSelector, provider: DocumentLinkProvider): Disposable;
    export function registerColorProvider(selector: DocumentSelector, provider: DocumentColorProvider): Disposable;
    export function registerInlayHintsProvider(selector: DocumentSelector, provider: InlayHintsProvider): Disposable;
    export function registerFoldingRangeProvider(selector: DocumentSelector, provider: FoldingRangeProvider): Disposable;
    export function registerSelectionRangeProvider(selector: DocumentSelector, provider: SelectionRangeProvider): Disposable;
    export function registerLinkedEditingRangeProvider(selector: DocumentSelector, provider: LinkedEditingRangeProvider): Disposable;
  }
}
