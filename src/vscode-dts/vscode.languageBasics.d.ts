declare module 'vscode' {
  // Language contributions (wr-1ejz): `contributes.languages`, `grammars` and `snippets` are read from the
  // manifest. The API adds the list of language ids.

  export namespace languages {
    export function getLanguages(): Thenable<string[]>;
  }
}
