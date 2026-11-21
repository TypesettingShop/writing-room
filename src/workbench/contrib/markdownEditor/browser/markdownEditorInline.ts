import { toggleMark } from 'prosemirror-commands';
import type { Mark } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import { createMarkdownIt } from '../../../../editor/common/markdown/markdownIt.js';
import { selectedTextBlocks } from './markdownEditorBlockStyles.js';
import type { SelectedTextBlock } from './markdownEditorBlockStyles.js';

const { normalizeLink, validateLink } = createMarkdownIt();

export function normalizeMarkdownLink(input: string): string | undefined {
  const text = input.trim();
  if (!text) {
    return '';
  }
  if (Array.from(text).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return undefined;
  }
  const href = normalizeLink(text);
  return validateLink(href) ? href : undefined;
}

export type MarkdownInlineMark = 'strong' | 'em' | 'strike' | 'code';

export function toggleInlineFormat(name: MarkdownInlineMark): Command {
  return (state, dispatch) => toggleMark(state.schema.marks[name])(state, dispatch);
}

export function isInlineFormatActive(state: EditorState, name: MarkdownInlineMark): boolean {
  const { schema, doc, selection } = state;
  const mark = schema.marks[name];
  if (selection.empty) {
    return Boolean(mark.isInSet(state.storedMarks ?? selection.$from.marks()));
  }
  return selection.ranges.some(range => doc.rangeHasMark(range.$from.pos, range.$to.pos, mark));
}

interface LinkRange {
  readonly from: number;
  readonly to: number;
  readonly mark: Mark;
}

/** Find one complete link covering the selection, including a caret on either edge of a link. */
export function linkAtSelection(
  state: EditorState, blocks: readonly SelectedTextBlock[] = selectedTextBlocks(state.doc, state.selection),
): LinkRange | undefined {
  if (blocks.length !== 1) {
    return undefined;
  }
  const [{ node, pos }] = blocks;
  const { from, to } = state.selection;
  const type = state.schema.marks.link;
  let current: LinkRange | undefined;
  let match: LinkRange | undefined;
  const coversSelection = (range: LinkRange) => range.from <= from && to <= range.to;
  node.forEach((child, offset) => {
    if (match) {
      return;
    }
    const mark = type.isInSet(child.marks);
    const start = pos + 1 + offset;
    const end = start + child.nodeSize;
    if (mark && current?.to === start && current.mark.eq(mark)) {
      current = { ...current, to: end };
      return;
    }
    if (current && coversSelection(current)) {
      match = current;
    }
    current = mark ? { from: start, to: end, mark } : undefined;
  });
  return match ?? (current && coversSelection(current) ? current : undefined);
}

export function setMarkdownLink(input: string): Command {
  const href = normalizeMarkdownLink(input);
  return (state, dispatch) => {
    const { selection, schema, doc } = state;
    const { link } = schema.marks;
    const blocks = selectedTextBlocks(doc, selection);
    if (href === undefined || !blocks.some(({ node }) => node.type.allowsMarkType(link))) {
      return false;
    }
    const current = linkAtSelection(state, blocks);
    const { from, to } = current ?? selection;
    const tr = state.tr;
    if (selection instanceof CellSelection && selection.ranges.length > 1) {
      // Each selected cell is a range of its own. Link its text instead of replacing the cells.
      for (const { $from, $to } of selection.ranges) {
        if ($from.pos === $to.pos) continue;
        if (href) tr.addMark($from.pos, $to.pos, link.create({ href }));
        else tr.removeMark($from.pos, $to.pos, link);
      }
    } else if (!href) {
      tr.removeMark(from, to, link);
    } else {
      const mark = link.create({ ...current?.mark.attrs, href });
      if (from === to) {
        const marks = mark.addToSet(state.storedMarks ?? selection.$from.marks());
        tr.replaceSelectionWith(schema.text(href, marks), false);
      } else {
        tr.addMark(from, to, mark);
      }
    }
    if (!tr.docChanged) {
      return false;
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}
