import { lift, wrapIn } from 'prosemirror-commands';
import type { Node } from 'prosemirror-model';
import type { Command, EditorState, Selection } from 'prosemirror-state';

type BlockStyle =
  | { readonly type: 'paragraph' | 'subtitle' | 'blockquote' | 'code_block' }
  | { readonly type: 'heading'; readonly level: number };

export const blockStyles: readonly { readonly label: string; readonly value: BlockStyle }[] = [
  { label: 'Body', value: { type: 'paragraph' } },
  ...Array.from({ length: 6 }, (_, index) => ({
    label: `Heading ${index + 1}`, value: { type: 'heading' as const, level: index + 1 },
  })),
  { label: 'Subtitle', value: { type: 'subtitle' } },
  { label: 'Block Quote', value: { type: 'blockquote' } },
  { label: 'Code Block', value: { type: 'code_block' } },
];

export function blockStyleKey(style: BlockStyle): string {
  return style.type === 'heading' ? `heading${style.level}` : style.type;
}

export function parseBlockStyle(arg: unknown): BlockStyle | undefined {
  if (typeof arg !== 'object' || arg === null || !('type' in arg)) {
    return undefined;
  }
  return blockStyles.find(({ value }) => value.type === arg.type &&
    (value.type !== 'heading' || ('level' in arg && arg.level === value.level)))?.value;
}

export interface SelectedTextBlock {
  readonly node: Node;
  readonly pos: number;
  /** Offsets inside the block's content. */
  readonly from: number;
  readonly to: number;
}

export function selectedTextBlocks(doc: Node, selection: Selection): SelectedTextBlock[] {
  const blocks: SelectedTextBlock[] = [];
  const { from, to, $from } = selection;
  if (selection.empty) {
    if ($from.parent.isTextblock && $from.depth > 0) {
      blocks.push({ node: $from.parent, pos: $from.before(), from: $from.parentOffset, to: $from.parentOffset });
    }
    return blocks;
  }
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) {
      return true;
    }
    const start = pos + 1;
    const end = start + node.content.size;
    if ((from < end && to > start) || (start === end && from <= start && to >= start)) {
      blocks.push({ node, pos, from: Math.max(0, from - start), to: Math.min(node.content.size, to - start) });
    }
    return false;
  });
  return blocks;
}

function styleOf(doc: Node, { node, pos }: SelectedTextBlock): string | null {
  switch (node.type.name) {
    case 'heading':
      return `heading${node.attrs.level}`;
    case 'code_block':
      return 'code_block';
    case 'paragraph':
      if (node.attrs.classes.includes('subtitle')) {
        return 'subtitle';
      }
      return doc.resolve(pos).parent.type.name === 'blockquote' ? 'blockquote' : 'paragraph';
    default:
      return null;
  }
}

export function currentBlockStyle(state: EditorState): string | null {
  const blocks = selectedTextBlocks(state.doc, state.selection);
  const first = blocks[0] && styleOf(state.doc, blocks[0]);
  return first && blocks.every(block => styleOf(state.doc, block) === first) ? first : null;
}

export function setBlockStyle(style: BlockStyle): Command {
  return (state, dispatch) => {
    const { schema, selection } = state;
    const inQuote = selection.$from.blockRange(selection.$to)?.parent.type === schema.nodes.blockquote;
    if (style.type === 'blockquote') {
      return inQuote ? lift(state, dispatch) : wrapIn(schema.nodes.blockquote)(state, dispatch);
    }
    if (style.type === 'paragraph' && inQuote && currentBlockStyle(state) === 'blockquote') {
      return lift(state, dispatch);
    }

    const type = schema.nodes[style.type === 'subtitle' ? 'paragraph' : style.type];
    const tr = state.tr;
    for (const { node, pos } of selectedTextBlocks(state.doc, selection)) {
      if (node.type.name === 'table_cell') {
        continue;
      }
      if (type === schema.nodes.code_block && node.type !== type) {
        const before = state.doc.resolve(pos);
        // Code blocks can carry text and line breaks, but cannot represent inline images or references.
        if (!before.parent.canReplaceWith(before.index(), before.index() + 1, type)
          || node.content.content.some(child => !child.isText &&
            child.type !== schema.nodes.soft_break && child.type !== schema.nodes.hard_break)) {
          continue;
        }
        node.forEach((child, offset) => {
          if (child.type === schema.nodes.hard_break) {
            const at = tr.mapping.map(pos + 1 + offset);
            tr.replaceWith(at, at + 1, schema.nodes.soft_break.create());
          }
        });
      }
      const classes = (node.attrs.classes as string[]).filter(name => name !== 'subtitle');
      if (style.type === 'subtitle') {
        classes.push('subtitle');
      }
      const attrs = { ...(node.type === type ? node.attrs : {}), classes };
      const start = tr.mapping.map(pos);
      const end = tr.mapping.map(pos + node.nodeSize, -1);
      tr.setBlockType(start, end, type, style.type === 'heading' ? { ...attrs, level: style.level } : attrs);
    }
    if (!tr.docChanged) {
      return false;
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}
