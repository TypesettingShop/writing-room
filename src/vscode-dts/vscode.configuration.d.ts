declare module 'vscode' {
  enum ConfigurationTarget {
    Global = 1,
    Workspace = 2,
    WorkspaceFolder = 3
  }

  interface WorkspaceConfiguration {
    get<T>(section: string): T | undefined;
    get<T>(section: string, defaultValue: T): T;
    has(section: string): boolean;
    inspect<T>(section: string): {
      key: string;
      defaultValue?: T;
      globalValue?: T;
      workspaceValue?: T;
      workspaceFolderValue?: T;
      defaultLanguageValue?: T;
      globalLanguageValue?: T;
      workspaceLanguageValue?: T;
      workspaceFolderLanguageValue?: T;
      languageIds?: string[];
    } | undefined;
    update(section: string, value: any, configurationTarget?: ConfigurationTarget | boolean | null, overrideInLanguage?: boolean): Thenable<void>;
    readonly [key: string]: any;
  }

  /**
   * Only the two members a configuration scope reads; the documents area declares the rest of
   * `TextDocument`, and the declarations merge.
   */
  interface TextDocument {
    readonly uri: Uri;
    readonly languageId: string;
  }

  type ConfigurationScope = Uri | TextDocument | WorkspaceFolder | {
    uri?: Uri;
    languageId: string;
  };

  interface ConfigurationChangeEvent {
    affectsConfiguration(section: string, scope?: ConfigurationScope): boolean;
  }

  namespace workspace {
    function getConfiguration(section?: string, scope?: ConfigurationScope | null): WorkspaceConfiguration;
    const onDidChangeConfiguration: Event<ConfigurationChangeEvent>;
  }
}
