import type { IDisposable } from '../../base/common/lifecycle.js';

// Where the workbench lends the editor package its text models. Monaco's own features (the Ctrl+hover
// definition preview, the references peek) ask Monaco's text model service for the model of a
// resource; the standalone service knows only models that exist already. The package loads on demand
// and takes its services once, when it first makes them, so the loader puts a service there that asks
// this hook on every call: the workbench can set its resolver before or after the package loads. The
// types stay untyped at this layer, which cannot name the editor package's.

/** A model lent under a reference; `dispose` gives it back. */
export interface EditorModelReference {
  /** The editor package's text model. */
  readonly model: unknown;
  dispose(): void;
}

export interface EditorTextModelResolver {
  /** Whether the workbench resolves `resource`, the editor package's URI as a string. */
  canResolve(resource: string): boolean;
  /** The model of `resource`, read if it is not open; rejects when there is none. */
  resolve(resource: string): Promise<EditorModelReference>;
}

let current: EditorTextModelResolver | undefined;

/** The resolver the editor package's text model service asks first, until the disposable is disposed. */
export function setEditorTextModelResolver(resolver: EditorTextModelResolver): IDisposable {
  current = resolver;
  return {
    dispose: () => {
      if (current === resolver) {
        current = undefined;
      }
    },
  };
}

/** The resolver set now, if any: a page without a workbench (the editor harness) has none. */
export function editorTextModelResolver(): EditorTextModelResolver | undefined {
  return current;
}
