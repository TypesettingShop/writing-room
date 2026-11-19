declare module 'vscode' {
  /** Resolves a custom editor over a text document: the document is the one text editors show. */
  interface CustomTextEditorProvider {
    resolveCustomTextEditor(document: TextDocument, webviewPanel: WebviewPanel, token: CancellationToken): Thenable<void> | void;
  }

  /** A document of a custom editor that keeps its own model; disposed when its last editor closes. */
  interface CustomDocument {
    readonly uri: Uri;
    dispose(): void;
  }

  interface CustomDocumentEditEvent<T extends CustomDocument = CustomDocument> {
    readonly document: T;
    undo(): Thenable<void> | void;
    redo(): Thenable<void> | void;
    readonly label?: string;
  }

  interface CustomDocumentContentChangeEvent<T extends CustomDocument = CustomDocument> {
    readonly document: T;
  }

  interface CustomDocumentBackup {
    readonly id: string;
    delete(): void;
  }

  interface CustomDocumentBackupContext {
    readonly destination: Uri;
  }

  interface CustomDocumentOpenContext {
    readonly backupId: string | undefined;
    readonly untitledDocumentData: Uint8Array | undefined;
  }

  interface CustomReadonlyEditorProvider<T extends CustomDocument = CustomDocument> {
    openCustomDocument(uri: Uri, openContext: CustomDocumentOpenContext, token: CancellationToken): Thenable<T> | T;
    resolveCustomEditor(document: T, webviewPanel: WebviewPanel, token: CancellationToken): Thenable<void> | void;
  }

  interface CustomEditorProvider<T extends CustomDocument = CustomDocument> extends CustomReadonlyEditorProvider<T> {
    readonly onDidChangeCustomDocument: Event<CustomDocumentEditEvent<T>> | Event<CustomDocumentContentChangeEvent<T>>;
    saveCustomDocument(document: T, cancellation: CancellationToken): Thenable<void>;
    saveCustomDocumentAs(document: T, destination: Uri, cancellation: CancellationToken): Thenable<void>;
    revertCustomDocument(document: T, cancellation: CancellationToken): Thenable<void>;
    backupCustomDocument(document: T, context: CustomDocumentBackupContext, cancellation: CancellationToken): Thenable<CustomDocumentBackup>;
  }

  namespace window {
    /**
     * Registers the provider of the custom editor `viewType`, which the extension contributes in
     * `contributes.customEditors`. One provider per `viewType`.
     */
    export function registerCustomEditorProvider(viewType: string, provider: CustomTextEditorProvider | CustomReadonlyEditorProvider | CustomEditorProvider, options?: {
      readonly webviewOptions?: WebviewPanelOptions;
      readonly supportsMultipleEditorsPerDocument?: boolean;
    }): Disposable;
  }
}
