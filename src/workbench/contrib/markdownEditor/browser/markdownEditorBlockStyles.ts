import { lift, wrapIn } from 'prosemirror-commands';
import { Fragment } from 'prosemirror-model';
import type { Node, NodeType } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command, Selection, Transaction } from 'prosemirror-state';

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

export function currentBlockStyle(state: EditorState, blocks = selectedTextBlocks(state.doc, state.selection)): string | null {
  const first = blocks[0] && styleOf(state.doc, blocks[0]);
  return first && blocks.every(block => styleOf(state.doc, block) === first) ? first : null;
}

/** Code text as the blocks Markdown reads back: blank lines separate blocks, edge newlines vanish. */
function codeTextBlocks(text: string): string[][] {
  const trimmed = text.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
  return trimmed.split(/\n(?:[ \t]*\n)+/).map(chunk => chunk.split('\n'));
}

export function setBlockStyle(style: BlockStyle): Command {
  return (state, dispatch) => {
    const { schema, selection, doc } = state;
    const blocks = selectedTextBlocks(doc, selection).filter(({ node }) => node.type !== schema.nodes.table_cell);
    const quoted = ({ pos }: SelectedTextBlock) => doc.resolve(pos).parent.type === schema.nodes.blockquote;
    const tr = state.tr;
    // Quote state is judged per block, so a selection over two quotes or a quote and plain text toggles each block once.
    const runInEach = (targets: readonly SelectedTextBlock[], command: Command) => {
      for (const { pos } of [...targets].reverse()) {
        const at = tr.mapping.map(pos) + 1;
        const block = EditorState.create({ schema, doc: tr.doc, selection: TextSelection.create(tr.doc, at) });
        command(block, inner => inner.steps.forEach(step => tr.step(step)));
      }
    };

    if (style.type === 'blockquote') {
      if (!blocks.some(quoted)) {
        return wrapIn(schema.nodes.blockquote)(state, dispatch);
      }
      if (currentBlockStyle(state) === 'blockquote') {
        runInEach(blocks, lift);
      } else {
        convertBlocks(tr, blocks.filter(quoted), schema.nodes.paragraph, { type: 'paragraph' });
        runInEach(blocks.filter(block => !quoted(block)), wrapIn(schema.nodes.blockquote));
      }
    } else {
      convertBlocks(tr, blocks, schema.nodes[style.type === 'subtitle' ? 'paragraph' : style.type], style);
      if (style.type === 'paragraph') {
        runInEach(blocks.filter(quoted), lift);
      }
    }
    if (!tr.docChanged) {
      return false;
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

function convertBlocks(tr: Transaction, blocks: readonly SelectedTextBlock[], type: NodeType, style: BlockStyle): void {
  const { schema } = type;
  for (const { node, pos } of blocks) {
    const classes = (node.attrs.classes as string[]).filter(name => name !== 'subtitle');
    if (style.type === 'subtitle') {
      classes.push('subtitle');
    }
    const base = { ...(node.type === type ? node.attrs : {}), classes };
    const attrs = style.type === 'heading' ? { ...base, level: style.level } : base;
    const start = tr.mapping.map(pos);
    const end = tr.mapping.map(pos + node.nodeSize, -1);
    if (node.type === schema.nodes.code_block && type !== node.type) {
      // A blank code line would become a block boundary once saved, so split there now and show what reopens.
      const replacement = codeTextBlocks(node.textContent).map(lines => type.create(attrs, lines.flatMap((line, index) => [
        ...(index > 0 ? [type === schema.nodes.heading ? schema.text(' ') : schema.nodes.soft_break.create()] : []),
        ...(line ? [schema.text(line)] : []),
      ])));
      const $start = tr.doc.resolve(start);
      if ($start.parent.canReplace($start.index(), $start.index() + 1, Fragment.from(replacement))) {
        tr.replaceWith(start, end, replacement);
      }
      continue;
    }
    if (type === schema.nodes.code_block && node.type !== type) {
      const before = tr.doc.resolve(start);
      // Code blocks can carry text and line breaks, but cannot represent inline images or references.
      if (!before.parent.canReplaceWith(before.index(), before.index() + 1, type)
        || node.content.content.some(child => !child.isText &&
          child.type !== schema.nodes.soft_break && child.type !== schema.nodes.hard_break)) {
        continue;
      }
    }
    const breakReplacement = type === schema.nodes.code_block ? schema.nodes.soft_break
      : type === schema.nodes.heading ? 'space' : undefined;
    if (breakReplacement && node.type !== type) {
      // An ATX heading ends at its line break, and a fence keeps only plain newlines.
      node.forEach((child, offset) => {
        if (child.type === schema.nodes.hard_break || (breakReplacement === 'space' && child.type === schema.nodes.soft_break)) {
          const at = tr.mapping.map(pos + 1 + offset);
          tr.replaceWith(at, at + 1, breakReplacement === 'space'
            ? schema.text(' ', child.marks) : schema.nodes.soft_break.create());
        }
      });
    }
    tr.setBlockType(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize, -1), type, attrs);
  }
}
