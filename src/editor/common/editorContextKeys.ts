import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';

export namespace EditorContextKeys {
  /** The editor's text area has focus. */
  export const editorTextFocus = new RawContextKey<boolean>('editorTextFocus', false);
  /** The editor or one of its widgets (find, say) has focus. */
  export const focus = new RawContextKey<boolean>('editorFocus', false);
  /** A text editor or a text input inside an editor has focus. */
  export const textInputFocus = new RawContextKey<boolean>('textInputFocus', false);
}
