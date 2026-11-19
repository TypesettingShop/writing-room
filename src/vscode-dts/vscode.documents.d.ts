declare module 'vscode' {
  export interface TextLine {
    readonly lineNumber: number;
    readonly text: string;
    readonly range: Range;
    readonly rangeIncludingLineBreak: Range;
    readonly firstNonWhitespaceCharacterIndex: number;
    readonly isEmptyOrWhitespace: boolean;
  }

  export interface TextDocument {
    readonly uri: Uri;
    readonly fileName: string;
    readonly isUntitled: boolean;
    readonly languageId: string;
    readonly encoding: string;
    readonly version: number;
    readonly isDirty: boolean;
    readonly isClosed: boolean;
    save(): Thenable<boolean>;
    readonly eol: EndOfLine;
    readonly lineCount: number;
    lineAt(line: number): TextLine;
    lineAt(position: Position): TextLine;
    offsetAt(position: Position): number;
    positionAt(offset: number): Position;
    getText(range?: Range): string;
    getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined;
    validateRange(range: Range): Range;
    validatePosition(position: Position): Position;
  }

  export interface TextDocumentContentProvider {
    onDidChange?: Event<Uri>;
    provideTextDocumentContent(uri: Uri, token: CancellationToken): ProviderResult<string>;
  }

  export interface TextDocumentContentChangeEvent {
    readonly range: Range;
    readonly rangeOffset: number;
    readonly rangeLength: number;
    readonly text: string;
  }

  export enum TextDocumentChangeReason { Undo = 1, Redo = 2 }

  export interface TextDocumentChangeEvent {
    readonly document: TextDocument;
    readonly contentChanges: readonly TextDocumentContentChangeEvent[];
    readonly reason: TextDocumentChangeReason | undefined;
  }

  export enum TextDocumentSaveReason { Manual = 1, AfterDelay = 2, FocusOut = 3 }

  export interface TextDocumentWillSaveEvent {
    readonly document: TextDocument;
    readonly reason: TextDocumentSaveReason;
    waitUntil(thenable: Thenable<readonly TextEdit[]>): void;
    waitUntil(thenable: Thenable<any>): void;
  }

  export namespace workspace {
    export const textDocuments: readonly TextDocument[];
    export function openTextDocument(uri: Uri, options?: { readonly encoding?: string }): Thenable<TextDocument>;
    export function openTextDocument(path: string, options?: { readonly encoding?: string }): Thenable<TextDocument>;
    export function openTextDocument(options?: {
      language?: string;
      content?: string;
      readonly encoding?: string;
    }): Thenable<TextDocument>;
    export function registerTextDocumentContentProvider(scheme: string, provider: TextDocumentContentProvider): Disposable;
    export const onDidOpenTextDocument: Event<TextDocument>;
    export const onDidCloseTextDocument: Event<TextDocument>;
    export const onDidChangeTextDocument: Event<TextDocumentChangeEvent>;
    export const onWillSaveTextDocument: Event<TextDocumentWillSaveEvent>;
    export const onDidSaveTextDocument: Event<TextDocument>;
  }

  export namespace languages {
    export function setTextDocumentLanguage(document: TextDocument, languageId: string): Thenable<TextDocument>;
  }
}
