declare module 'vscode' {
  interface WebviewPortMapping {
    readonly webviewPort: number;
    readonly extensionHostPort: number;
  }

  interface WebviewOptions {
    readonly enableScripts?: boolean;
    readonly enableForms?: boolean;
    readonly enableCommandUris?: boolean | readonly string[];
    readonly localResourceRoots?: readonly Uri[];
    readonly portMapping?: readonly WebviewPortMapping[];
  }

  interface Webview {
    options: WebviewOptions;
    html: string;
    readonly onDidReceiveMessage: Event<any>;
    postMessage(message: any): Thenable<boolean>;
    asWebviewUri(localResource: Uri): Uri;
    readonly cspSource: string;
  }

  interface WebviewPanelOptions {
    readonly enableFindWidget?: boolean;
    readonly retainContextWhenHidden?: boolean;
  }

  interface WebviewPanel {
    readonly viewType: string;
    title: string;
    iconPath?: IconPath;
    readonly webview: Webview;
    readonly options: WebviewPanelOptions;
    readonly viewColumn: ViewColumn | undefined;
    readonly active: boolean;
    readonly visible: boolean;
    readonly onDidChangeViewState: Event<WebviewPanelOnDidChangeViewStateEvent>;
    readonly onDidDispose: Event<void>;
    reveal(viewColumn?: ViewColumn, preserveFocus?: boolean): void;
    dispose(): any;
  }

  interface WebviewPanelOnDidChangeViewStateEvent {
    readonly webviewPanel: WebviewPanel;
  }

  interface WebviewPanelSerializer<T = unknown> {
    deserializeWebviewPanel(webviewPanel: WebviewPanel, state: T): Thenable<void>;
  }

  interface WebviewView {
    readonly viewType: string;
    readonly webview: Webview;
    title?: string;
    description?: string;
    readonly onDidDispose: Event<void>;
    readonly visible: boolean;
    readonly onDidChangeVisibility: Event<void>;
    show(preserveFocus?: boolean): void;
  }

  interface WebviewViewResolveContext<T = unknown> {
    readonly state: T | undefined;
  }

  interface WebviewViewProvider {
    resolveWebviewView(webviewView: WebviewView, context: WebviewViewResolveContext, token: CancellationToken): Thenable<void> | void;
  }

  namespace window {
    export function createWebviewPanel(viewType: string, title: string, showOptions: ViewColumn | {
      readonly viewColumn: ViewColumn;
      readonly preserveFocus?: boolean;
    }, options?: WebviewPanelOptions & WebviewOptions): WebviewPanel;
    export function registerWebviewViewProvider(viewId: string, provider: WebviewViewProvider, options?: {
      readonly webviewOptions?: {
        readonly retainContextWhenHidden?: boolean;
      };
    }): Disposable;
    export function registerWebviewPanelSerializer(viewType: string, serializer: WebviewPanelSerializer): Disposable;
  }
}
