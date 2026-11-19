declare module 'vscode' {
  // Quick pick and input box (wr-x0vf.6wt). Item icons, item buttons and the folder pick are not supported.

  enum QuickPickItemKind {
    Separator = -1,
    Default = 0,
  }

  interface QuickPickItem {
    label: string;
    kind?: QuickPickItemKind;
    description?: string;
    detail?: string;
    picked?: boolean;
    alwaysShow?: boolean;
  }

  interface QuickPickOptions {
    title?: string;
    matchOnDescription?: boolean;
    matchOnDetail?: boolean;
    placeHolder?: string;
    prompt?: string;
    ignoreFocusOut?: boolean;
    canPickMany?: boolean;
    onDidSelectItem?(item: QuickPickItem | string): any;
  }

  enum InputBoxValidationSeverity {
    Info = 1,
    Warning = 2,
    Error = 3
  }

  interface InputBoxValidationMessage {
    readonly message: string;
    readonly severity: InputBoxValidationSeverity;
  }

  interface InputBoxOptions {
    title?: string;
    value?: string;
    valueSelection?: [number, number];
    prompt?: string;
    placeHolder?: string;
    password?: boolean;
    ignoreFocusOut?: boolean;
    validateInput?(value: string): string | InputBoxValidationMessage | undefined | null |
      Thenable<string | InputBoxValidationMessage | undefined | null>;
  }

  interface QuickInput {
    title: string | undefined;
    step: number | undefined;
    totalSteps: number | undefined;
    enabled: boolean;
    busy: boolean;
    ignoreFocusOut: boolean;
    show(): void;
    hide(): void;
    readonly onDidHide: Event<void>;
    dispose(): void;
  }

  interface QuickPick<T extends QuickPickItem> extends QuickInput {
    value: string;
    placeholder: string | undefined;
    prompt: string | undefined;
    readonly onDidChangeValue: Event<string>;
    readonly onDidAccept: Event<void>;
    buttons: readonly QuickInputButton[];
    readonly onDidTriggerButton: Event<QuickInputButton>;
    items: readonly T[];
    canSelectMany: boolean;
    matchOnDescription: boolean;
    matchOnDetail: boolean;
    activeItems: readonly T[];
    readonly onDidChangeActive: Event<readonly T[]>;
    selectedItems: readonly T[];
    readonly onDidChangeSelection: Event<readonly T[]>;
  }

  interface InputBox extends QuickInput {
    value: string;
    valueSelection: readonly [number, number] | undefined;
    placeholder: string | undefined;
    password: boolean;
    readonly onDidChangeValue: Event<string>;
    readonly onDidAccept: Event<void>;
    buttons: readonly QuickInputButton[];
    readonly onDidTriggerButton: Event<QuickInputButton>;
    prompt: string | undefined;
    validationMessage: string | InputBoxValidationMessage | undefined;
  }

  interface QuickInputButton {
    readonly iconPath: IconPath;
    readonly tooltip?: string | undefined;
  }

  class QuickInputButtons {
    static readonly Back: QuickInputButton;
    private constructor();
  }

  namespace window {
    function showQuickPick(items: readonly string[] | Thenable<readonly string[]>, options: QuickPickOptions & { /** literal-type defines return type */canPickMany: true }, token?: CancellationToken): Thenable<string[] | undefined>;
    function showQuickPick(items: readonly string[] | Thenable<readonly string[]>, options?: QuickPickOptions, token?: CancellationToken): Thenable<string | undefined>;
    function showQuickPick<T extends QuickPickItem>(items: readonly T[] | Thenable<readonly T[]>, options: QuickPickOptions & { /** literal-type defines return type */ canPickMany: true }, token?: CancellationToken): Thenable<T[] | undefined>;
    function showQuickPick<T extends QuickPickItem>(items: readonly T[] | Thenable<readonly T[]>, options?: QuickPickOptions, token?: CancellationToken): Thenable<T | undefined>;
    function showInputBox(options?: InputBoxOptions, token?: CancellationToken): Thenable<string | undefined>;
    function createQuickPick<T extends QuickPickItem>(): QuickPick<T>;
    function createInputBox(): InputBox;
  }

  // Output channels (wr-x0vf.jgz). The text is kept in memory, 1 MiB per channel; `languageId` is accepted
  // and not used.

  interface OutputChannel {
    readonly name: string;
    append(value: string): void;
    appendLine(value: string): void;
    replace(value: string): void;
    clear(): void;
    show(preserveFocus?: boolean): void;
    show(column?: ViewColumn, preserveFocus?: boolean): void;
    hide(): void;
    dispose(): void;
  }

  interface LogOutputChannel extends OutputChannel {
    readonly logLevel: LogLevel;
    readonly onDidChangeLogLevel: Event<LogLevel>;
    trace(message: string, ...args: any[]): void;
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(error: string | Error, ...args: any[]): void;
  }

  namespace window {
    function createOutputChannel(name: string, languageId?: string): OutputChannel;
    function createOutputChannel(name: string, options: { /** literal-type defines return type */log: true }): LogOutputChannel;
  }
}

declare module 'vscode' {
  // Message options, progress and status bar messages (wr-x0vf.hyt). `MessageItem` is a shared type.

  interface MessageOptions {
    modal?: boolean;
    detail?: string;
  }

  enum ProgressLocation {
    SourceControl = 1,
    Window = 10,
    Notification = 15
  }

  interface ProgressOptions {
    location: ProgressLocation | {
      viewId: string;
    };
    title?: string;
    cancellable?: boolean;
  }

  interface Progress<T> {
    report(value: T): void;
  }

  namespace window {
    function showInformationMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>;
    function showInformationMessage<T extends MessageItem>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>;
    function showWarningMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>;
    function showWarningMessage<T extends MessageItem>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>;
    function showErrorMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>;
    function showErrorMessage<T extends MessageItem>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>;
    function setStatusBarMessage(text: string, hideAfterTimeout: number): Disposable;
    function setStatusBarMessage(text: string, hideWhenDone: Thenable<any>): Disposable;
    function setStatusBarMessage(text: string): Disposable;
    function withProgress<R>(options: ProgressOptions, task: (progress: Progress<{
      message?: string;
      increment?: number;
    }>, token: CancellationToken) => Thenable<R>): Thenable<R>;
  }
}
