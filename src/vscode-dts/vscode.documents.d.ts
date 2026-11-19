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

declare module 'vscode' {
  export enum TextEditorSelectionChangeKind { Keyboard = 1, Mouse = 2, Command = 3 }
  export enum TextEditorCursorStyle { Line = 1, Block = 2, Underline = 3, LineThin = 4, BlockOutline = 5, UnderlineThin = 6 }
  export enum TextEditorLineNumbersStyle { Off = 0, On = 1, Relative = 2, Interval = 3 }
  export enum TextEditorRevealType { Default = 0, InCenter = 1, InCenterIfOutsideViewport = 2, AtTop = 3 }

  export interface TextEditorSelectionChangeEvent {
    readonly textEditor: TextEditor;
    readonly selections: readonly Selection[];
    readonly kind: TextEditorSelectionChangeKind | undefined;
  }

  export interface TextEditorVisibleRangesChangeEvent {
    readonly textEditor: TextEditor;
    readonly visibleRanges: readonly Range[];
  }

  export interface TextEditorOptionsChangeEvent {
    readonly textEditor: TextEditor;
    readonly options: TextEditorOptions;
  }

  export interface TextEditorViewColumnChangeEvent {
    readonly textEditor: TextEditor;
    readonly viewColumn: ViewColumn;
  }

  export interface TextEditorOptions {
    tabSize?: number | string;
    indentSize?: number | string;
    insertSpaces?: boolean | string;
    cursorStyle?: TextEditorCursorStyle;
    lineNumbers?: TextEditorLineNumbersStyle;
  }

  export interface TextDocumentShowOptions {
    viewColumn?: ViewColumn;
    preserveFocus?: boolean;
    preview?: boolean;
    selection?: Range;
  }

  export interface TextEditorEdit {
    replace(location: Position | Range | Selection, value: string): void;
    insert(location: Position, value: string): void;
    delete(location: Range | Selection): void;
    setEndOfLine(endOfLine: EndOfLine): void;
  }

  export interface TextEditor {
    readonly document: TextDocument;
    selection: Selection;
    selections: readonly Selection[];
    readonly visibleRanges: readonly Range[];
    options: TextEditorOptions;
    readonly viewColumn: ViewColumn | undefined;
    edit(callback: (editBuilder: TextEditorEdit) => void, options?: {
      readonly undoStopBefore: boolean;
      readonly undoStopAfter: boolean;
    }): Thenable<boolean>;
    insertSnippet(snippet: SnippetString, location?: Position | Range | readonly Position[] | readonly Range[], options?: {
      readonly undoStopBefore: boolean;
      readonly undoStopAfter: boolean;
      readonly keepWhitespace?: boolean;
    }): Thenable<boolean>;
    revealRange(range: Range, revealType?: TextEditorRevealType): void;
    show(column?: ViewColumn): void;
    hide(): void;
  }

  export namespace window {
    export const activeTextEditor: TextEditor | undefined;
    export const visibleTextEditors: readonly TextEditor[];
    export const onDidChangeActiveTextEditor: Event<TextEditor | undefined>;
    export const onDidChangeVisibleTextEditors: Event<readonly TextEditor[]>;
    export const onDidChangeTextEditorSelection: Event<TextEditorSelectionChangeEvent>;
    export const onDidChangeTextEditorVisibleRanges: Event<TextEditorVisibleRangesChangeEvent>;
    export const onDidChangeTextEditorOptions: Event<TextEditorOptionsChangeEvent>;
    export const onDidChangeTextEditorViewColumn: Event<TextEditorViewColumnChangeEvent>;
    export function showTextDocument(document: TextDocument, column?: ViewColumn, preserveFocus?: boolean): Thenable<TextEditor>;
    export function showTextDocument(document: TextDocument, options?: TextDocumentShowOptions): Thenable<TextEditor>;
    export function showTextDocument(uri: Uri, options?: TextDocumentShowOptions): Thenable<TextEditor>;
  }
}
