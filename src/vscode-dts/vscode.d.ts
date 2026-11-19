declare module 'vscode' {
  interface Disposable {
    dispose(): any;
  }

  class Disposable {
    constructor(callOnDispose: () => any);
    static from(...disposableLikes: { dispose: () => any }[]): Disposable;
  }

  interface Event<T> {
    (listener: (e: T) => any, thisArgs?: any, disposables?: Disposable[]): Disposable;
  }

  class EventEmitter<T> {
    event: Event<T>;
    fire(data: T): void;
    dispose(): void;
  }

  interface Extension<T> {
    readonly id: string;
    readonly packageJSON: any;
  }

  interface ExtensionContext {
    readonly subscriptions: { dispose(): any }[];
    readonly extensionUri: Uri;
    readonly extension: Extension<any>;
  }

  namespace commands {
    function registerCommand(command: string, callback: (...args: any[]) => any, thisArg?: any): Disposable;
    function executeCommand<T = unknown>(command: string, ...rest: any[]): Thenable<T>;
  }

  interface Command {
    title: string;
    command: string;
    tooltip?: string;
    arguments?: any[];
  }

  interface TreeItemLabel {
    label: string;
    highlights?: [number, number][];
  }

  enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }

  class TreeItem {
    label?: string | TreeItemLabel;
    id?: string;
    description?: string | boolean;
    tooltip?: string | MarkdownString | undefined;
    command?: Command;
    collapsibleState?: TreeItemCollapsibleState;
    contextValue?: string;
    constructor(label: string | TreeItemLabel, collapsibleState?: TreeItemCollapsibleState);
  }

  type ProviderResult<T> = T | undefined | null | Thenable<T | undefined | null>;

  interface TreeDataProvider<T> {
    onDidChangeTreeData?: Event<T | T[] | undefined | null | void>;
    getTreeItem(element: T): TreeItem | Thenable<TreeItem>;
    getChildren(element?: T): ProviderResult<T[]>;
  }

  interface TreeViewOptions<T> {
    treeDataProvider: TreeDataProvider<T>;
  }

  interface TreeView<T> extends Disposable {}

  enum StatusBarAlignment { Left = 1, Right = 2 }

  interface StatusBarItem {
    readonly id: string;
    readonly alignment: StatusBarAlignment;
    readonly priority: number | undefined;
    name: string | undefined;
    text: string;
    tooltip: string | MarkdownString | undefined;
    command: string | Command | undefined;
    show(): void;
    hide(): void;
    dispose(): void;
  }

  interface MessageItem {
    title: string;
    isCloseAffordance?: boolean;
  }

  namespace window {
    function registerTreeDataProvider<T>(viewId: string, treeDataProvider: TreeDataProvider<T>): Disposable;
    function createTreeView<T>(viewId: string, options: TreeViewOptions<T>): TreeView<T>;
    function createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
    function showInformationMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>;
    function showInformationMessage<T extends MessageItem>(message: string, ...items: T[]): Thenable<T | undefined>;
    function showWarningMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>;
    function showWarningMessage<T extends MessageItem>(message: string, ...items: T[]): Thenable<T | undefined>;
    function showErrorMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>;
    function showErrorMessage<T extends MessageItem>(message: string, ...items: T[]): Thenable<T | undefined>;
  }

  const version: string;

  class Position {
    readonly line: number;
    readonly character: number;
    constructor(line: number, character: number);
    isBefore(other: Position): boolean;
    isBeforeOrEqual(other: Position): boolean;
    isAfter(other: Position): boolean;
    isAfterOrEqual(other: Position): boolean;
    isEqual(other: Position): boolean;
    compareTo(other: Position): number;
    translate(lineDelta?: number, characterDelta?: number): Position;
    translate(change: {
      lineDelta?: number;
      characterDelta?: number;
    }): Position;
    with(line?: number, character?: number): Position;
    with(change: {
      line?: number;
      character?: number;
    }): Position;
  }

  class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(start: Position, end: Position);
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
    isEmpty: boolean;
    isSingleLine: boolean;
    contains(positionOrRange: Position | Range): boolean;
    isEqual(other: Range): boolean;
    intersection(range: Range): Range | undefined;
    union(other: Range): Range;
    with(start?: Position, end?: Position): Range;
    with(change: {
      start?: Position;
      end?: Position;
    }): Range;
  }

  class Selection extends Range {
    readonly anchor: Position;
    readonly active: Position;
    constructor(anchor: Position, active: Position);
    constructor(anchorLine: number, anchorCharacter: number, activeLine: number, activeCharacter: number);
    readonly isReversed: boolean;
  }

  class ThemeColor {
    readonly id: string;
    constructor(id: string);
  }

  class ThemeIcon {
    static readonly File: ThemeIcon;
    static readonly Folder: ThemeIcon;
    readonly id: string;
    readonly color?: ThemeColor | undefined;
    constructor(id: string, color?: ThemeColor);
  }

  type IconPath = Uri | {
    light: Uri;
    dark: Uri;
  } | ThemeIcon;

  enum EndOfLine {
    LF = 1,
    CRLF = 2
  }

  class Uri {
    static parse(value: string, strict?: boolean): Uri;
    static file(path: string): Uri;
    static joinPath(base: Uri, ...pathSegments: string[]): Uri;
    static from(components: {
      readonly scheme: string;
      readonly authority?: string;
      readonly path?: string;
      readonly query?: string;
      readonly fragment?: string;
    }): Uri;
    private constructor(scheme: string, authority: string, path: string, query: string, fragment: string);
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
    readonly fsPath: string;
    with(change: {
      scheme?: string;
      authority?: string;
      path?: string;
      query?: string;
      fragment?: string;
    }): Uri;
    toString(skipEncoding?: boolean): string;
    toJSON(): any;
  }

  interface CancellationToken {
    isCancellationRequested: boolean;
    readonly onCancellationRequested: Event<any>;
  }

  class CancellationTokenSource {
    token: CancellationToken;
    cancel(): void;
    dispose(): void;
  }

  class CancellationError extends Error {
    constructor();
  }

  class RelativePattern {
    baseUri: Uri;
    base: string;
    pattern: string;
    constructor(base: WorkspaceFolder | Uri | string, pattern: string);
  }

  class MarkdownString {
    value: string;
    isTrusted?: boolean | {
      readonly enabledCommands: readonly string[];
    };
    supportThemeIcons?: boolean;
    supportHtml?: boolean;
    baseUri?: Uri;
    constructor(value?: string, supportThemeIcons?: boolean);
    appendText(value: string): MarkdownString;
    appendMarkdown(value: string): MarkdownString;
    appendCodeblock(value: string, language?: string): MarkdownString;
  }

  class TextEdit {
    static replace(range: Range, newText: string): TextEdit;
    static insert(position: Position, newText: string): TextEdit;
    static delete(range: Range): TextEdit;
    static setEndOfLine(eol: EndOfLine): TextEdit;
    range: Range;
    newText: string;
    newEol?: EndOfLine;
    constructor(range: Range, newText: string);
  }

  class SnippetTextEdit {
    static replace(range: Range, snippet: SnippetString): SnippetTextEdit;
    static insert(position: Position, snippet: SnippetString): SnippetTextEdit;
    range: Range;
    snippet: SnippetString;
    keepWhitespace?: boolean;
    constructor(range: Range, snippet: SnippetString);
  }

  interface WorkspaceEditEntryMetadata {
    needsConfirmation: boolean;
    label: string;
    description?: string;
    iconPath?: IconPath;
  }

  class WorkspaceEdit {
    readonly size: number;
    replace(uri: Uri, range: Range, newText: string, metadata?: WorkspaceEditEntryMetadata): void;
    insert(uri: Uri, position: Position, newText: string, metadata?: WorkspaceEditEntryMetadata): void;
    delete(uri: Uri, range: Range, metadata?: WorkspaceEditEntryMetadata): void;
    has(uri: Uri): boolean;
    set(uri: Uri, edits: ReadonlyArray<TextEdit | SnippetTextEdit>): void;
    set(uri: Uri, edits: ReadonlyArray<[
      TextEdit | SnippetTextEdit,
      WorkspaceEditEntryMetadata | undefined
    ]>): void;
    get(uri: Uri): TextEdit[];
    createFile(uri: Uri, options?: {
      readonly overwrite?: boolean;
      readonly ignoreIfExists?: boolean;
      readonly contents?: Uint8Array | DataTransferFile;
    }, metadata?: WorkspaceEditEntryMetadata): void;
    deleteFile(uri: Uri, options?: {
      readonly recursive?: boolean;
      readonly ignoreIfNotExists?: boolean;
    }, metadata?: WorkspaceEditEntryMetadata): void;
    renameFile(oldUri: Uri, newUri: Uri, options?: {
      readonly overwrite?: boolean;
      readonly ignoreIfExists?: boolean;
    }, metadata?: WorkspaceEditEntryMetadata): void;
    entries(): [
      Uri,
      TextEdit[]
    ][];
  }

  class SnippetString {
    value: string;
    constructor(value?: string);
    appendText(string: string): SnippetString;
    appendTabstop(number?: number): SnippetString;
    appendPlaceholder(value: string | ((snippet: SnippetString) => any), number?: number): SnippetString;
    appendChoice(values: readonly string[], number?: number): SnippetString;
    appendVariable(name: string, defaultValue: string | ((snippet: SnippetString) => any)): SnippetString;
  }

  class Location {
    uri: Uri;
    range: Range;
    constructor(uri: Uri, rangeOrPosition: Range | Position);
  }

  enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two = 2,
    Three = 3,
    Four = 4,
    Five = 5,
    Six = 6,
    Seven = 7,
    Eight = 8,
    Nine = 9
  }

  enum LogLevel {
    Off = 0,
    Trace = 1,
    Debug = 2,
    Info = 3,
    Warning = 4,
    Error = 5
  }

  interface DataTransferFile {
    readonly name: string;
    readonly uri?: Uri;
    data(): Thenable<Uint8Array>;
  }

  class DataTransferItem {
    asString(): Thenable<string>;
    asFile(): DataTransferFile | undefined;
    readonly value: any;
    constructor(value: any);
  }

  class DataTransfer implements Iterable<[
    mimeType: string,
    item: DataTransferItem
  ]> {
    get(mimeType: string): DataTransferItem | undefined;
    set(mimeType: string, value: DataTransferItem): void;
    forEach(callbackfn: (item: DataTransferItem, mimeType: string, dataTransfer: DataTransfer) => void, thisArg?: any): void;
    [Symbol.iterator](): IterableIterator<[
      mimeType: string,
      item: DataTransferItem
    ]>;
  }

  interface WorkspaceFolder {
    readonly uri: Uri;
    readonly name: string;
    readonly index: number;
  }
}

interface Thenable<T> extends PromiseLike<T> {}
