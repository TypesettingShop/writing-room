import { extname } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { FILE_EDITOR_INPUT_ID } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export type MarkdownEditorMode = 'wysiwyg' | 'source';
export const markdownContentLayouts = ['center', 'fill'] as const;
export type MarkdownContentLayout = typeof markdownContentLayouts[number];
export const defaultMarkdownContentLayout: MarkdownContentLayout = 'center';

export const MARKDOWN_EDITOR_INPUT_ID = 'workbench.editors.markdownEditorInput';
export const MARKDOWN_EDITOR_DEFAULT_MODE = 'markdownEditor.defaultMode';
export const MARKDOWN_EDITOR_CONTENT_WIDTH = 'markdownEditor.contentWidth';
export const MARKDOWN_EDITOR_CONTENT_LAYOUT = 'markdownEditor.contentLayout';
export const MARKDOWN_EDITOR_FONT_FAMILY = 'markdownEditor.fontFamily';
export const MARKDOWN_EDITOR_FOCUS_WIDTH = 'markdownEditor.focusMode.width';
export const MARKDOWN_EDITOR_FOCUS_DIM = 'markdownEditor.focusMode.dimOthers';
export const MARKDOWN_EDITOR_TYPEWRITER = 'markdownEditor.typewriterScroll';
export const defaultMarkdownFocusWidth = '72ch';
export const markdownContentWidth = { min: 20, max: 400, defaultValue: 80 };
export const defaultMarkdownFontFamilies = { serif: 'Georgia, serif', sans: 'system-ui, sans-serif' };
export const MarkdownEditorModeContext = new RawContextKey<MarkdownEditorMode | null>('markdownEditorMode', null);
export const MarkdownEditorFocusContext = new RawContextKey<boolean>('markdownEditorFocus', false);
export const MarkdownEditorContentWidthContext = new RawContextKey<number>(
  MARKDOWN_EDITOR_CONTENT_WIDTH, markdownContentWidth.defaultValue,
);
export const MarkdownEditorContentLayoutContext = new RawContextKey<MarkdownContentLayout>(
  MARKDOWN_EDITOR_CONTENT_LAYOUT, defaultMarkdownContentLayout,
);
export const MarkdownEditorWritableContext = new RawContextKey<boolean>('markdownEditor.writable', false);
export const MarkdownEditorBlockTypeContext = new RawContextKey<string | null>('markdownEditor.blockType', null);
export const MarkdownEditorTextAlignContext = new RawContextKey<string | null>('markdownEditor.textAlign', null);
export const MarkdownEditorFontSizeContext = new RawContextKey<string | null>('markdownEditor.fontSize', null);
export const MarkdownEditorFontFamilyContext = new RawContextKey<string | null>('markdownEditor.fontFamily', null);
export const MarkdownEditorInlineFormattingContext = new RawContextKey<boolean>('markdownEditor.inlineFormatting', false);
export const MarkdownEditorLinkContext = new RawContextKey<boolean>('markdownEditor.isLink', false);
export const MarkdownEditorInlineMarkContexts = {
  strong: new RawContextKey<boolean>('markdownEditor.isBold', false),
  em: new RawContextKey<boolean>('markdownEditor.isItalic', false),
  strike: new RawContextKey<boolean>('markdownEditor.isStrike', false),
  code: new RawContextKey<boolean>('markdownEditor.isCode', false),
};
export const MarkdownEditorCanUndoContext = new RawContextKey<boolean>('markdownEditorCanUndo', false);
export const MarkdownEditorCanRedoContext = new RawContextKey<boolean>('markdownEditorCanRedo', false);

export function isMarkdownContentWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= markdownContentWidth.min && value <= markdownContentWidth.max;
}

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
