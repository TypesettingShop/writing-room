import type { URI } from '../../../base/common/uri.js';

export interface IEditorOptions {
  /** Open without moving keyboard focus into the editor. */
  readonly preserveFocus?: boolean;
  /**
   * The id of the registered editor to open a resource with, as the editor resolver knows it,
   * instead of the one it would pick. Only an opening by resource reads it.
   */
  readonly override?: string;
}

/** A selection in a text editor. Without an end it is a cursor at the start. All 1-based. */
export interface ITextEditorSelection {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber?: number;
  readonly endColumn?: number;
}

export interface ITextEditorOptions extends IEditorOptions {
  /**
   * What `EditorPane.getViewState()` returned for this input in another pane, such as the cursor,
   * selection and scroll position. It restores in place of the view state this pane saved.
   */
  readonly viewState?: object;
  /** Selects this range and reveals it, after any view state. */
  readonly selection?: ITextEditorSelection;
}

/** An editor named by its resource alone; the editor resolver turns it into an input. */
export interface IResourceEditorInput {
  readonly resource: URI;
  readonly options?: ITextEditorOptions;
}

export function isResourceEditorInput(value: unknown): value is IResourceEditorInput {
  return typeof value === 'object' && value !== null && 'resource' in value
    && typeof (value as { resource: unknown }).resource === 'object' && (value as { resource: unknown }).resource !== null
    && typeof (value as { typeId?: unknown }).typeId !== 'string';
}
