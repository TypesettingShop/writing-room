import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

// The languages the workbench knows. Contributions (`contributes.languages`, `grammars`, `snippets`) are
// read on the main thread; the extension host only asks for the list of language ids.

export interface MainThreadLanguagesShape {
  /** The ids of every registered language: built-in and contributed. */
  $getLanguages(): Promise<string[]>;
}

export const MainThreadLanguagesProxy = createProxyIdentifier<MainThreadLanguagesShape>('MainThreadLanguages');
