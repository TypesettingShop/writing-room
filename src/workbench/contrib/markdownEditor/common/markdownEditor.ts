import { extname } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { FILE_EDITOR_INPUT_ID } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export type MarkdownEditorMode = 'wysiwyg' | 'source';

export const MARKDOWN_EDITOR_INPUT_ID = 'workbench.editors.markdownEditorInput';
export const MARKDOWN_EDITOR_DEFAULT_MODE = 'markdownEditor.defaultMode';
export const MarkdownEditorModeContext = new RawContextKey<MarkdownEditorMode | null>('markdownEditorMode', null);
export const MarkdownEditorFocusContext = new RawContextKey<boolean>('markdownEditorFocus', false);
export const MarkdownEditorWritableContext = new RawContextKey<boolean>('markdownEditor.writable', false);
export const MarkdownEditorBlockTypeContext = new RawContextKey<string | null>('markdownEditor.blockType', null);
export const MarkdownEditorCanUndoContext = new RawContextKey<boolean>('markdownEditorCanUndo', false);
export const MarkdownEditorCanRedoContext = new RawContextKey<boolean>('markdownEditorCanRedo', false);

export function isMarkdownResource(resource: URI): boolean {
  const extension = extname(resource).toLowerCase();
  return extension === '.md' || extension === '.markdown';
}

/** The input type persists the mode when editor tabs are serialized. */
export function getMarkdownEditorMode(editor: EditorInput | undefined): MarkdownEditorMode | null {
  if (editor?.typeId === MARKDOWN_EDITOR_INPUT_ID) {
    return 'wysiwyg';
  }
  return editor?.typeId === FILE_EDITOR_INPUT_ID && editor.resource && isMarkdownResource(editor.resource) ? 'source' : null;
}
