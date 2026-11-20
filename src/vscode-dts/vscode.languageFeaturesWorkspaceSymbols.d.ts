declare module 'vscode' {
  // Workspace symbols (wr-c9d8.qq0): the providers Go to Symbol in Workspace and
  // `vscode.executeWorkspaceSymbolProvider` ask.

  export interface WorkspaceSymbolProvider<T extends SymbolInformation = SymbolInformation> {
    provideWorkspaceSymbols(query: string, token: CancellationToken): ProviderResult<T[]>;
    resolveWorkspaceSymbol?(symbol: T, token: CancellationToken): ProviderResult<T>;
  }

  export namespace languages {
    export function registerWorkspaceSymbolProvider(provider: WorkspaceSymbolProvider): Disposable;
  }
}
