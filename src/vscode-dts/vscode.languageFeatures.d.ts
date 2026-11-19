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

  export namespace languages {
    export function match(selector: DocumentSelector, document: TextDocument): number;
    export function setLanguageConfiguration(language: string, configuration: LanguageConfiguration): Disposable;
  }
}
