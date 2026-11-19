import type { IDisposable } from '../../../base/common/lifecycle.js';

// Where the color theme reaches the editor package. The package loads on demand, so the theme service
// cannot give it a theme until it has loaded; the loader announces the namespace here, before the first
// editor exists. The namespace is untyped at this layer, which cannot name the editor package's types.

let loaded: { readonly namespace: unknown } | undefined;
const listeners = new Set<(namespace: unknown) => void>();

/** Called by the editor package's loader once, with its namespace. */
export function announceEditorLoaded(namespace: unknown): void {
  loaded = { namespace };
  for (const listener of [...listeners]) {
    try {
      listener(namespace);
    } catch (error) {
      console.error(error);
    }
  }
}

/**
 * Calls `listener` with the editor package's namespace when it has loaded, and at once when it has
 * already. It never loads the package.
 */
export function onDidLoadEditor<T>(listener: (namespace: T) => void): IDisposable {
  const untyped = listener as (namespace: unknown) => void;
  listeners.add(untyped);
  if (loaded) {
    untyped(loaded.namespace);
  }
  return { dispose: () => listeners.delete(untyped) };
}
