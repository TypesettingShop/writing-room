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

  export namespace languages {
    export function match(selector: DocumentSelector, document: TextDocument): number;
    export function setLanguageConfiguration(language: string, configuration: LanguageConfiguration): Disposable;
    export function registerCompletionItemProvider(selector: DocumentSelector, provider: CompletionItemProvider, ...triggerCharacters: string[]): Disposable;
    export function registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): Disposable;
    export function registerSignatureHelpProvider(selector: DocumentSelector, provider: SignatureHelpProvider, ...triggerCharacters: string[]): Disposable;
    export function registerSignatureHelpProvider(selector: DocumentSelector, provider: SignatureHelpProvider, metadata: SignatureHelpProviderMetadata): Disposable;
  }
}
