declare module 'vscode' {
  enum ExtensionKind {
    UI = 1,
    Workspace = 2,
  }

  enum ExtensionMode {
    Production = 1,
    Development = 2,
    Test = 3,
  }

  interface Extension<T> {
    readonly extensionUri: Uri;
    readonly extensionPath: string;
    readonly isActive: boolean;
    extensionKind: ExtensionKind;
    readonly exports: T;
    activate(): Thenable<T>;
  }

  interface ExtensionContext {
    readonly workspaceState: Memento;
    readonly globalState: Memento & { setKeysForSync(keys: readonly string[]): void; };
    readonly secrets: SecretStorage;
    readonly extensionPath: string;
    readonly environmentVariableCollection: GlobalEnvironmentVariableCollection;
    asAbsolutePath(relativePath: string): string;
    readonly storageUri: Uri | undefined;
    readonly storagePath: string | undefined;
    readonly globalStorageUri: Uri;
    readonly globalStoragePath: string;
    readonly logUri: Uri;
    readonly logPath: string;
    readonly extensionMode: ExtensionMode;
  }

  interface Memento {
    keys(): readonly string[];
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: any): Thenable<void>;
  }

  interface SecretStorageChangeEvent {
    readonly key: string;
  }

  interface SecretStorage {
    keys(): Thenable<string[]>;
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
    readonly onDidChange: Event<SecretStorageChangeEvent>;
  }

  enum EnvironmentVariableMutatorType {
    Replace = 1,
    Append = 2,
    Prepend = 3,
  }

  interface EnvironmentVariableMutatorOptions {
    applyAtProcessCreation?: boolean;
    applyAtShellIntegration?: boolean;
  }

  interface EnvironmentVariableMutator {
    readonly type: EnvironmentVariableMutatorType;
    readonly value: string;
    readonly options: EnvironmentVariableMutatorOptions;
  }

  interface EnvironmentVariableCollection extends Iterable<[variable: string, mutator: EnvironmentVariableMutator]> {
    persistent: boolean;
    description: string | MarkdownString | undefined;
    replace(variable: string, value: string, options?: EnvironmentVariableMutatorOptions): void;
    append(variable: string, value: string, options?: EnvironmentVariableMutatorOptions): void;
    prepend(variable: string, value: string, options?: EnvironmentVariableMutatorOptions): void;
    get(variable: string): EnvironmentVariableMutator | undefined;
    forEach(callback: (variable: string, mutator: EnvironmentVariableMutator, collection: EnvironmentVariableCollection) => any, thisArg?: any): void;
    delete(variable: string): void;
    clear(): void;
  }

  interface GlobalEnvironmentVariableCollection extends EnvironmentVariableCollection {
    getScoped(scope: EnvironmentVariableScope): EnvironmentVariableCollection;
  }

  interface EnvironmentVariableScope {
    workspaceFolder?: WorkspaceFolder;
  }
}

declare module 'vscode' {

  enum UIKind {
    Desktop = 1,
    Web = 2,
  }

  interface Clipboard {
    readText(): Thenable<string>;
    writeText(value: string): Thenable<void>;
  }

  class TelemetryTrustedValue<T = any> {
    readonly value: T;
    constructor(value: T);
  }

  interface TelemetryLogger {
    readonly onDidChangeEnableStates: Event<TelemetryLogger>;
    readonly isUsageEnabled: boolean;
    readonly isErrorsEnabled: boolean;
    logUsage(eventName: string, data?: Record<string, any | TelemetryTrustedValue>): void;
    logError(eventName: string, data?: Record<string, any | TelemetryTrustedValue>): void;
    logError(error: Error, data?: Record<string, any | TelemetryTrustedValue>): void;
    dispose(): void;
  }

  interface TelemetrySender {
    sendEventData(eventName: string, data?: Record<string, any>): void;
    sendErrorData(error: Error, data?: Record<string, any>): void;
    flush?(): void | Thenable<void>;
  }

  interface TelemetryLoggerOptions {
    readonly ignoreBuiltInCommonProperties?: boolean;
    readonly ignoreUnhandledErrors?: boolean;
    readonly additionalCommonProperties?: Record<string, any>;
  }

  namespace env {
    const appName: string;
    const appHost: string;
    const uriScheme: string;
    const language: string;
    const clipboard: Clipboard;
    const machineId: string;
    const sessionId: string;
    const isTelemetryEnabled: boolean;
    const onDidChangeTelemetryEnabled: Event<boolean>;
    const remoteName: string | undefined;
    const shell: string;
    const uiKind: UIKind;
    const logLevel: LogLevel;
    const onDidChangeLogLevel: Event<LogLevel>;
    function openExternal(target: Uri): Thenable<boolean>;
    function asExternalUri(target: Uri): Thenable<Uri>;
    function createTelemetryLogger(sender: TelemetrySender, options?: TelemetryLoggerOptions): TelemetryLogger;
  }

  namespace extensions {
    function getExtension<T = any>(extensionId: string): Extension<T> | undefined;
    const all: readonly Extension<any>[];
    const onDidChange: Event<void>;
  }

  namespace workspace {
    const isTrusted: boolean;
    const onDidGrantWorkspaceTrust: Event<void>;
  }
}

declare module 'vscode' {
  namespace l10n {
    function t(message: string, ...args: Array<string | number | boolean>): string;
    function t(message: string, args: Record<string, string | number | boolean>): string;
    function t(options: {
      message: string;
      args?: Array<string | number | boolean> | Record<string, string | number | boolean>;
      comment: string | string[];
    }): string;
    const bundle: { [key: string]: string } | undefined;
    const uri: Uri | undefined;
  }
}

declare module 'vscode' {
  enum TaskRevealKind { Always = 1, Silent = 2, Never = 3 }
  enum TaskPanelKind { Shared = 1, Dedicated = 2, New = 3 }
  enum TaskScope { Global = 1, Workspace = 2 }
  enum ShellQuoting { Escape = 1, Strong = 2, Weak = 3 }

  interface TaskPresentationOptions {
    reveal?: TaskRevealKind;
    echo?: boolean;
    focus?: boolean;
    panel?: TaskPanelKind;
    showReuseMessage?: boolean;
    clear?: boolean;
    close?: boolean;
  }

  class TaskGroup {
    static Clean: TaskGroup;
    static Build: TaskGroup;
    static Rebuild: TaskGroup;
    static Test: TaskGroup;
    readonly isDefault: boolean | undefined;
    readonly id: string;
    private constructor(id: string, label: string);
  }

  interface TaskDefinition {
    readonly type: string;
    [name: string]: any;
  }

  interface ProcessExecutionOptions {
    cwd?: string;
    env?: { [key: string]: string };
  }

  class ProcessExecution {
    constructor(process: string, options?: ProcessExecutionOptions);
    constructor(process: string, args: string[], options?: ProcessExecutionOptions);
    process: string;
    args: string[];
    options?: ProcessExecutionOptions;
  }

  interface ShellQuotingOptions {
    escape?: string | { escapeChar: string; charsToEscape: string; };
    strong?: string;
    weak?: string;
  }

  interface ShellExecutionOptions {
    executable?: string;
    shellArgs?: string[];
    shellQuoting?: ShellQuotingOptions;
    cwd?: string;
    env?: { [key: string]: string };
  }

  interface ShellQuotedString {
    value: string;
    quoting: ShellQuoting;
  }

  class ShellExecution {
    constructor(commandLine: string, options?: ShellExecutionOptions);
    constructor(command: string | ShellQuotedString, args: Array<string | ShellQuotedString>, options?: ShellExecutionOptions);
    commandLine: string | undefined;
    command: string | ShellQuotedString | undefined;
    args: Array<string | ShellQuotedString> | undefined;
    options?: ShellExecutionOptions;
  }

  interface TerminalDimensions {
    readonly columns: number;
    readonly rows: number;
  }

  interface Pseudoterminal {
    onDidWrite: Event<string>;
    onDidOverrideDimensions?: Event<TerminalDimensions | undefined>;
    onDidClose?: Event<void | number>;
    onDidChangeName?: Event<string>;
    open(initialDimensions: TerminalDimensions | undefined): void;
    close(): void;
    handleInput?(data: string): void;
    setDimensions?(dimensions: TerminalDimensions): void;
  }

  class CustomExecution {
    constructor(callback: (resolvedDefinition: TaskDefinition) => Thenable<Pseudoterminal>);
  }

  interface RunOptions {
    reevaluateOnRerun?: boolean;
  }

  class Task {
    constructor(taskDefinition: TaskDefinition, scope: WorkspaceFolder | TaskScope.Global | TaskScope.Workspace, name: string, source: string, execution?: ProcessExecution | ShellExecution | CustomExecution, problemMatchers?: string | string[]);
    constructor(taskDefinition: TaskDefinition, name: string, source: string, execution?: ProcessExecution | ShellExecution, problemMatchers?: string | string[]);
    definition: TaskDefinition;
    readonly scope: TaskScope.Global | TaskScope.Workspace | WorkspaceFolder | undefined;
    name: string;
    detail?: string;
    execution?: ProcessExecution | ShellExecution | CustomExecution;
    isBackground: boolean;
    source: string;
    group?: TaskGroup;
    presentationOptions: TaskPresentationOptions;
    problemMatchers: string[];
    runOptions: RunOptions;
  }

  interface TaskProvider<T extends Task = Task> {
    provideTasks(token: CancellationToken): ProviderResult<T[]>;
    resolveTask(task: T, token: CancellationToken): ProviderResult<T>;
  }

  interface TaskExecution {
    task: Task;
    terminate(): void;
  }

  interface TaskStartEvent { readonly execution: TaskExecution; }
  interface TaskEndEvent { readonly execution: TaskExecution; }
  interface TaskProcessStartEvent {
    readonly execution: TaskExecution;
    readonly processId: number;
  }
  interface TaskProcessEndEvent {
    readonly execution: TaskExecution;
    readonly exitCode: number | undefined;
  }
  interface TaskFilter {
    version?: string;
    type?: string;
  }

  namespace tasks {
    function registerTaskProvider(type: string, provider: TaskProvider): Disposable;
    function fetchTasks(filter?: TaskFilter): Thenable<Task[]>;
    function executeTask(task: Task): Thenable<TaskExecution>;
    const taskExecutions: readonly TaskExecution[];
    const onDidStartTask: Event<TaskStartEvent>;
    const onDidEndTask: Event<TaskEndEvent>;
    const onDidStartTaskProcess: Event<TaskProcessStartEvent>;
    const onDidEndTaskProcess: Event<TaskProcessEndEvent>;
  }

  // The proposed API externalUriOpener (vscode.proposed.externalUriOpener.d.ts upstream), accepted and never asked.
  enum ExternalUriOpenerPriority {
    None = 0,
    Option = 1,
    Default = 2,
    Preferred = 3,
  }

  interface ExternalUriOpener {
    canOpenExternalUri(uri: Uri, token: CancellationToken): ExternalUriOpenerPriority | Thenable<ExternalUriOpenerPriority>;
    openExternalUri(resolvedUri: Uri, ctx: OpenExternalUriContext, token: CancellationToken): Thenable<void> | void;
  }

  interface OpenExternalUriContext {
    readonly sourceUri: Uri;
    readonly viewColumn?: ViewColumn;
  }

  interface ExternalUriOpenerMetadata {
    readonly schemes: readonly string[];
    readonly label: string;
  }

  namespace window {
    function registerExternalUriOpener(id: string, opener: ExternalUriOpener, metadata: ExternalUriOpenerMetadata): Disposable;
  }

  enum NotebookCellKind { Markup = 1, Code = 2 }

  interface NotebookDocument {
    readonly uri: Uri;
    readonly notebookType: string;
    readonly version: number;
    readonly isDirty: boolean;
    readonly isUntitled: boolean;
    readonly isClosed: boolean;
    readonly metadata: { [key: string]: any };
    readonly cellCount: number;
    save(): Thenable<boolean>;
  }

  interface NotebookDocumentChangeEvent {
    readonly notebook: NotebookDocument;
    readonly metadata: { [key: string]: any } | undefined;
  }

  namespace workspace {
    const notebookDocuments: readonly NotebookDocument[];
    const onDidChangeNotebookDocument: Event<NotebookDocumentChangeEvent>;
    const onDidSaveNotebookDocument: Event<NotebookDocument>;
    const onDidOpenNotebookDocument: Event<NotebookDocument>;
    const onDidCloseNotebookDocument: Event<NotebookDocument>;
  }
}
