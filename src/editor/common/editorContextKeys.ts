import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';

export namespace EditorContextKeys {
  /** The editor's text area has focus. */
  export const editorTextFocus = new RawContextKey<boolean>('editorTextFocus', false);
  /** The editor or one of its widgets (find, say) has focus. */
  export const focus = new RawContextKey<boolean>('editorFocus', false);
  /** A text editor or a text input inside an editor has focus. */
  export const textInputFocus = new RawContextKey<boolean>('textInputFocus', false);
  /** The language of the model the editor shows; empty while it shows none. */
  export const languageId = new RawContextKey<string>('editorLangId', '');
  /** The editor's input cannot be changed. */
  export const readOnly = new RawContextKey<boolean>('editorReadonly', false);
  /** Some text is selected. */
  export const hasNonEmptySelection = new RawContextKey<boolean>('editorHasSelection', false);
}
