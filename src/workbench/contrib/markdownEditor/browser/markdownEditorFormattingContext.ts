import type { EditorState } from 'prosemirror-state';
import type { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import {
  MarkdownEditorBlockTypeContext, MarkdownEditorFontFamilyContext, MarkdownEditorFontSizeContext,
  MarkdownEditorInlineFormattingContext, MarkdownEditorInlineMarkContexts, MarkdownEditorLinkContext,
  MarkdownEditorTextAlignContext,
} from '../common/markdownEditor.js';
import { currentBlockStyle, selectedTextBlocks } from './markdownEditorBlockStyles.js';
import { isInlineFormatActive, linkAtSelection } from './markdownEditorInline.js';
import type { MarkdownInlineMark } from './markdownEditorInline.js';
import { currentFormattingPresets } from './markdownEditorPresets.js';

export function bindMarkdownFormattingContext(scope: IContextKeyService): (state: EditorState | undefined) => void {
  const blockType = MarkdownEditorBlockTypeContext.bindTo(scope);
  const alignment = MarkdownEditorTextAlignContext.bindTo(scope);
  const fontSize = MarkdownEditorFontSizeContext.bindTo(scope);
  const fontFamily = MarkdownEditorFontFamilyContext.bindTo(scope);
  const inline = MarkdownEditorInlineFormattingContext.bindTo(scope);
  const link = MarkdownEditorLinkContext.bindTo(scope);
  const marks = (Object.keys(MarkdownEditorInlineMarkContexts) as MarkdownInlineMark[]).map(name =>
    [name, MarkdownEditorInlineMarkContexts[name].bindTo(scope)] as const);

  return state => {
    const blocks = state ? selectedTextBlocks(state.doc, state.selection) : [];
    blockType.set(state ? currentBlockStyle(state, blocks) : null);
    const presets = state ? currentFormattingPresets(state, blocks) : undefined;
    alignment.set(presets?.textAlign ?? null);
    fontSize.set(presets?.fontSize ?? null);
    fontFamily.set(presets?.fontFamily ?? null);
    inline.set(Boolean(state && blocks.some(({ node }) => node.type.allowsMarkType(state.schema.marks.link))));
    link.set(Boolean(state && linkAtSelection(state, blocks)));
    for (const [name, key] of marks) {
      key.set(Boolean(state && isInlineFormatActive(state, name)));
    }
  };
}
