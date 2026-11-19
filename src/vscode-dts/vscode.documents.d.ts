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
    export let activeTextEditor: TextEditor | undefined;
    export let visibleTextEditors: readonly TextEditor[];
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

  export interface WorkspaceEditMetadata {
    isRefactoring?: boolean;
  }

  export namespace workspace {
    export function applyEdit(edit: WorkspaceEdit, metadata?: WorkspaceEditMetadata): Thenable<boolean>;
  }

  export interface TextEditorDecorationType {
    readonly key: string;
    dispose(): void;
  }

  export enum OverviewRulerLane { Left = 1, Center = 2, Right = 4, Full = 7 }
  export enum DecorationRangeBehavior { OpenOpen = 0, ClosedClosed = 1, OpenClosed = 2, ClosedOpen = 3 }

  export interface ThemableDecorationRenderOptions {
    backgroundColor?: string | ThemeColor;
    outline?: string;
    outlineColor?: string | ThemeColor;
    outlineStyle?: string;
    outlineWidth?: string;
    border?: string;
    borderColor?: string | ThemeColor;
    borderRadius?: string;
    borderSpacing?: string;
    borderStyle?: string;
    borderWidth?: string;
    fontStyle?: string;
    fontWeight?: string;
    textDecoration?: string;
    cursor?: string;
    color?: string | ThemeColor;
    opacity?: string;
    letterSpacing?: string;
    gutterIconPath?: string | Uri;
    gutterIconSize?: string;
    overviewRulerColor?: string | ThemeColor;
    before?: ThemableDecorationAttachmentRenderOptions;
    after?: ThemableDecorationAttachmentRenderOptions;
  }

  export interface ThemableDecorationAttachmentRenderOptions {
    contentText?: string;
    contentIconPath?: string | Uri;
    border?: string;
    borderColor?: string | ThemeColor;
    fontStyle?: string;
    fontWeight?: string;
    textDecoration?: string;
    color?: string | ThemeColor;
    backgroundColor?: string | ThemeColor;
    margin?: string;
    width?: string;
    height?: string;
  }

  export interface DecorationRenderOptions extends ThemableDecorationRenderOptions {
    isWholeLine?: boolean;
    rangeBehavior?: DecorationRangeBehavior;
    overviewRulerLane?: OverviewRulerLane;
    light?: ThemableDecorationRenderOptions;
    dark?: ThemableDecorationRenderOptions;
  }

  export type MarkedString = string | { language: string; value: string };

  export interface DecorationOptions {
    range: Range;
    hoverMessage?: MarkdownString | MarkedString | Array<MarkdownString | MarkedString>;
    renderOptions?: DecorationInstanceRenderOptions;
  }

  export interface ThemableDecorationInstanceRenderOptions {
    before?: ThemableDecorationAttachmentRenderOptions;
    after?: ThemableDecorationAttachmentRenderOptions;
  }

  export interface DecorationInstanceRenderOptions extends ThemableDecorationInstanceRenderOptions {
    light?: ThemableDecorationInstanceRenderOptions;
    dark?: ThemableDecorationInstanceRenderOptions;
  }

  export interface TextEditor {
    setDecorations(decorationType: TextEditorDecorationType, rangesOrOptions: readonly Range[] | readonly DecorationOptions[]): void;
  }

  export namespace window {
    export function createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType;
  }

  export class TabInputText {
    readonly uri: Uri;
    constructor(uri: Uri);
  }

  export class TabInputTextDiff {
    readonly original: Uri;
    readonly modified: Uri;
    constructor(original: Uri, modified: Uri);
  }

  export class TabInputCustom {
    readonly uri: Uri;
    readonly viewType: string;
    constructor(uri: Uri, viewType: string);
  }

  export class TabInputWebview {
    readonly viewType: string;
    constructor(viewType: string);
  }

  export class TabInputNotebook {
    readonly uri: Uri;
    readonly notebookType: string;
    constructor(uri: Uri, notebookType: string);
  }

  export class TabInputNotebookDiff {
    readonly original: Uri;
    readonly modified: Uri;
    readonly notebookType: string;
    constructor(original: Uri, modified: Uri, notebookType: string);
  }

  export class TabInputTerminal {
    constructor();
  }

  export interface Tab {
    readonly label: string;
    readonly group: TabGroup;
    readonly input: TabInputText | TabInputTextDiff | TabInputCustom | TabInputWebview | TabInputNotebook
      | TabInputNotebookDiff | TabInputTerminal | unknown;
    readonly isActive: boolean;
    readonly isDirty: boolean;
    readonly isPinned: boolean;
    readonly isPreview: boolean;
  }

  export interface TabChangeEvent {
    readonly opened: readonly Tab[];
    readonly closed: readonly Tab[];
    readonly changed: readonly Tab[];
  }

  export interface TabGroupChangeEvent {
    readonly opened: readonly TabGroup[];
    readonly closed: readonly TabGroup[];
    readonly changed: readonly TabGroup[];
  }

  export interface TabGroup {
    readonly isActive: boolean;
    readonly viewColumn: ViewColumn;
    readonly activeTab: Tab | undefined;
    readonly tabs: readonly Tab[];
  }

  export interface TabGroups {
    readonly all: readonly TabGroup[];
    readonly activeTabGroup: TabGroup;
    readonly onDidChangeTabGroups: Event<TabGroupChangeEvent>;
    readonly onDidChangeTabs: Event<TabChangeEvent>;
    close(tab: Tab | readonly Tab[], preserveFocus?: boolean): Thenable<boolean>;
    close(tabGroup: TabGroup | readonly TabGroup[], preserveFocus?: boolean): Thenable<boolean>;
  }

  export namespace window {
    export const tabGroups: TabGroups;
  }
}
