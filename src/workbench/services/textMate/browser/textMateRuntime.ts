// Loaded on demand: the TextMate engine and the Oniguruma WebAssembly it needs are fetched the first time
// a language with a grammar is used, never with the workbench.
import * as textMateModule from 'vscode-textmate';
import * as onigurumaModule from 'vscode-oniguruma';
import onigurumaWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';
import type { IOnigLib } from 'vscode-textmate';

export type TextMateEngine = typeof textMateModule;

export interface ITextMateRuntime {
  readonly textMate: TextMateEngine;
  readonly onigLib: IOnigLib;
}

/** A CommonJS package may arrive as its exports or as a module whose default is its exports. */
function exportsOf<T extends object>(module: T, member: string): T {
  const fallback = (module as { default?: T }).default;
  return member in module || !fallback ? module : fallback;
}

/** Fetches the WebAssembly, starts Oniguruma, and returns the engine. Rejects when either fails. */
export async function loadTextMateRuntime(): Promise<ITextMateRuntime> {
  const textMate = exportsOf(textMateModule, 'Registry');
  const oniguruma = exportsOf(onigurumaModule, 'loadWASM');
  const response = await fetch(onigurumaWasmUrl, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`Could not fetch the Oniguruma WebAssembly (${response.status}).`);
  }
  await oniguruma.loadWASM(await response.arrayBuffer());
  return {
    textMate,
    onigLib: {
      createOnigScanner: sources => new oniguruma.OnigScanner(sources),
      createOnigString: text => new oniguruma.OnigString(text),
    },
  };
}
