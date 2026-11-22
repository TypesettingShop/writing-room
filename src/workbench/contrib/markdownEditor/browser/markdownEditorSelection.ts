import type { Node, NodeType } from 'prosemirror-model';
import { PluginKey, TextSelection } from 'prosemirror-state';
import type { Selection } from 'prosemirror-state';
import type { IParsedMarkdown } from '../../../../editor/common/markdown/parser.js';
import { parseMarkdownWithSource } from '../../../../editor/common/markdown/parser.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import type { ITextEditorSelection } from '../../../../platform/editor/common/editor.js';

export const markdownCaretParagraphKey = new PluginKey('markdownCaretParagraph');

// A private attrs object identifies each temporary paragraph and the side of its gutter target.
const caretParagraphs = new WeakMap<Node['attrs'], -1 | 1>();

export function createMarkdownCaretParagraph(type: NodeType, side: -1 | 1): Node {
  const paragraph = type.create({});
  caretParagraphs.set(paragraph.attrs, side);
  return paragraph;
}

export function isEmptyMarkdownCaretParagraph(node: Node): boolean {
  return markdownCaretParagraphSide(node) !== undefined;
}

export function markdownCaretParagraphSide(node: Node): -1 | 1 | undefined {
  return node.childCount === 0 ? caretParagraphs.get(node.attrs) : undefined;
}

export function authorMarkdownCaretParagraph(node: Node): void {
  caretParagraphs.delete(node.attrs);
}

interface Range {
  readonly from: number;
  readonly to: number;
}

interface Block {
  readonly document: Range;
  readonly source: Range;
  readonly text: readonly { document: Range; source: Range }[];
}

function mapBlocks(model: ITextModel, doc: Node, parsed?: IParsedMarkdown): Block[] {
  const source = model.getValue();
  parsed ??= parseMarkdownWithSource(source);
  const ranges = new Map(parsed.blocks.map(block => [block.from, block]));
  const sourceBlocks: (Range | undefined)[] = [];
  parsed.doc.forEach((_node, offset) => {
    const range = ranges.get(offset);
    sourceBlocks.push(range && { from: range.startOffset, to: range.endOffset });
  });

  const blocks: Block[] = [];
  let index = 0;
  doc.forEach((node, offset) => {
    if (isEmptyMarkdownCaretParagraph(node)) return;
    const range = sourceBlocks[index++];
    if (!range) {
      return;
    }
    const chunks: Block['text'][number][] = [];
    let cursor = range.from;
    // The parser gives the outer block's range. Within it, match written text in order so
    // Markdown markers do not normally count toward a text column.
    const raw = source.slice(range.from, range.to);
    node.descendants((child, pos) => {
      if (!child.text) {
        return;
      }
      const start = raw.indexOf(child.text, cursor - range.from);
      if (start !== -1) {
        const from = offset + 1 + pos;
        cursor = start + range.from + child.text.length;
        chunks.push({ document: { from, to: from + child.text.length }, source: { from: start + range.from, to: cursor } });
      }
    });
    blocks.push({ document: { from: offset, to: offset + node.nodeSize }, source: range, text: chunks });
  });
  return blocks;
}

function mapPosition(blocks: readonly Block[], value: number, from: 'document' | 'source', to: 'source' | 'document'): number {
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (value < blocks[mid][from].to) high = mid;
    else low = mid + 1;
  }
  const block = blocks[low] ?? blocks.at(-1);
  if (!block) {
    return 0;
  }
  const text = block.text.find(item => value <= item[from].to) ?? block.text.at(-1);
  if (!text) {
    // A position after the last mapped block, such as an empty paragraph below a final rule, follows that block.
    return value >= block[from].to ? block[to].to : block[to].from;
  }
  const delta = Math.max(0, Math.min(value, text[from].to) - text[from].from);
  return text[to].from + delta;
}

function mapSourcePosition(doc: Node, blocks: readonly Block[], value: number): number {
  const last = blocks.at(-1);
  if (last && value < last.document.to && isEmptyMarkdownCaretParagraph(doc.resolve(value).parent)) {
    // A display-only paragraph before a block has no source line. Land in nearby text so typing
    // after switching modes cannot prefix a Markdown delimiter such as a horizontal rule.
    let previous: number | undefined;
    for (const block of blocks) {
      if (block.document.from > value) {
        const at = previous ?? block.text[0]?.source.from;
        if (at !== undefined) return at;
      } else {
        previous = block.text.at(-1)?.source.to ?? previous;
      }
    }
    return last.source.to;
  }
  return mapPosition(blocks, value, 'document', 'source');
}

export function toSourceSelection(model: ITextModel, doc: Node, from: number, to: number): ITextEditorSelection {
  const blocks = mapBlocks(model, doc);
  const start = model.getPositionAt(mapSourcePosition(doc, blocks, from));
  const end = model.getPositionAt(mapSourcePosition(doc, blocks, to));
  return { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
}

export function toMarkdownSelection(model: ITextModel, doc: Node, range: ITextEditorSelection): Selection {
  const blocks = mapBlocks(model, doc);
  const start = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
  const end = range.endLineNumber === undefined ? start
    : model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn ?? range.startColumn });
  const anchor = doc.resolve(mapPosition(blocks, start, 'source', 'document'));
  const head = doc.resolve(mapPosition(blocks, end, 'source', 'document'));
  return TextSelection.between(anchor, head);
}


export function sourceWritingPositions(model: ITextModel, parsed: IParsedMarkdown): {
  toDocument(sourceOffset: number): number;
  toSource(documentOffset: number): number;
} {
  const blocks = mapBlocks(model, parsed.doc, parsed);
  return {
    toDocument: sourceOffset => mapPosition(blocks, sourceOffset, 'source', 'document'),
    toSource: documentOffset => mapPosition(blocks, documentOffset, 'document', 'source'),
  };
}
