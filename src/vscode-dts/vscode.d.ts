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
}

interface Thenable<T> extends PromiseLike<T> {}
