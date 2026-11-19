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

  interface Uri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
    toString(skipEncoding?: boolean): string;
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

  interface MarkdownString {
    value: string;
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
}

interface Thenable<T> extends PromiseLike<T> {}
