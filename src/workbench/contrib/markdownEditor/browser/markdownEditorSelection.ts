import type { Node } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { Selection } from 'prosemirror-state';
import { parseMarkdownWithSource } from '../../../../editor/common/markdown/parser.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import type { ITextEditorSelection } from '../../../../platform/editor/common/editor.js';

interface Range {
  readonly from: number;
  readonly to: number;
}

interface Block {
  readonly document: Range;
  readonly source: Range;
  readonly text: readonly { document: Range; source: Range }[];
}

function mapBlocks(model: ITextModel, doc: Node): Block[] {
  const source = model.getValue();
  const parsed = parseMarkdownWithSource(source);
  const ranges = new Map(parsed.blocks.map(block => [block.from, block]));
  const sourceBlocks: (Range | undefined)[] = [];
  parsed.doc.forEach((_node, offset) => {
    const range = ranges.get(offset);
    sourceBlocks.push(range && { from: range.startOffset, to: range.endOffset });
  });

  const blocks: Block[] = [];
  doc.forEach((node, offset, index) => {
    const range = sourceBlocks[index];
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
  const block = blocks.find(item => value < item[from].to) ?? blocks.at(-1);
  if (!block) {
    return 0;
  }
  const text = block.text.find(item => value <= item[from].to) ?? block.text.at(-1);
  if (!text) {
    return block[to].from;
  }
  const delta = Math.max(0, Math.min(value, text[from].to) - text[from].from);
  return text[to].from + delta;
}

export function toSourceSelection(model: ITextModel, doc: Node, from: number, to: number): ITextEditorSelection {
  const blocks = mapBlocks(model, doc);
  const start = model.getPositionAt(mapPosition(blocks, from, 'document', 'source'));
  const end = model.getPositionAt(mapPosition(blocks, to, 'document', 'source'));
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
