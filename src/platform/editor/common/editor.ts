export interface IEditorOptions {
  /** Open without moving keyboard focus into the editor. */
  readonly preserveFocus?: boolean;
}

export interface ITextEditorOptions extends IEditorOptions {
  /**
   * What `EditorPane.getViewState()` returned for this input in another pane, such as the cursor,
   * selection and scroll position. It restores in place of the view state this pane saved.
   */
  readonly viewState?: object;
}
