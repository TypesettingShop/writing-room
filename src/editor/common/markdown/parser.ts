import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type { Node } from 'prosemirror-model';
import { MarkdownParser } from 'prosemirror-markdown';
import type { ParseSpec } from 'prosemirror-markdown';
import { createMarkdownIt } from './markdownIt.js';
import type { IMarkdownItOptions } from './markdownIt.js';
import { getMarkdownClasses } from './plugins/attrs.js';
import { markdownSchema } from './schema.js';
import { wrapMarkdownRule } from './rules.js';

export interface IMarkdownSourceBlock {
  readonly from: number;
  readonly to: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly startOffset: number;
  readonly endOffset: number;
  /** Explicit empty cells are anchored by their closing pipe. Padding has a zero-width range. */
  readonly tableCell?: 'text' | 'empty' | 'padding';
  readonly tableRow?: TableRowBoundaries;
  /** Nested ranges exclude trailing whitespace and the optional opening pipe of a table row. */
  readonly children?: readonly IMarkdownSourceBlock[];
}

export interface IParsedMarkdown {
  readonly doc: Node;
  readonly blocks: readonly IMarkdownSourceBlock[];
  readonly includesChildRanges: boolean;
}

type LineRange = [start: number, end: number];

interface SourceToken {
  readonly type: string;
  readonly range: LineRange | null;
  readonly cell?: TableCellSource;
  readonly row?: TableRowBoundaries;
  readonly children: SourceToken[];
}

interface TableRowBoundaries {
  /** Source offset of the opening pipe or the line break before the row. */
  readonly start: number;
  /** Source offset of the closing pipe or the line break after the row. Absent at EOF without a pipe. */
  readonly end?: number;
}

interface TableCellSource {
  readonly range: LineRange;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly tableCell: NonNullable<IMarkdownSourceBlock['tableCell']>;
}

interface IParseEnvironment {
  readonly source: string;
  readonly lines: number[];
  readonly includeChildRanges: boolean;
  readonly blocks: { range: LineRange | null; children?: readonly SourceToken[] }[];
  footnotes?: { list?: { content?: string }[] };
}

const nodesWithClasses: Record<string, string> = {
  paragraph: 'paragraph',
  blockquote: 'blockquote',
  list_item: 'list_item',
  table: 'table',
  tr: 'table_row',
};

function blockAttrs(token: Token) {
  return { classes: getMarkdownClasses(token) };
}

function listAttrs(token: Token, tokens: Token[], index: number) {
  for (let next = index + 1; next < tokens.length && tokens[next].level > token.level; next++) {
    const candidate = tokens[next];
    if (candidate.level === token.level + 2 && candidate.type === 'paragraph_open') {
      return { ...blockAttrs(token), tight: candidate.hidden };
    }
  }
  return { ...blockAttrs(token), tight: true };
}

function cellAttrs(token: Token) {
  return { ...blockAttrs(token), align: token.attrGet('style')?.match(/^text-align:(left|center|right)$/)?.[1] ?? null };
}

function imageAlt(tokens: readonly Token[]): string {
  return tokens.map(token => token.type === 'image'
    ? imageAlt(token.children ?? [])
    : token.type === 'softbreak' || token.type === 'hardbreak'
      ? '\n'
      // An alt is plain text, so a footnote in it keeps its spelling.
      : token.type === 'footnote_ref'
        ? token.meta.label == null ? '^[' + (token.meta.source ?? '') + ']' : '[^' + token.meta.label + ']'
        : ['text', 'code_inline', 'text_special', 'unresolved_footnote_ref'].includes(token.type) ? token.content : '').join('');
}

const tokenSpecs: Record<string, ParseSpec> = {
  ...Object.fromEntries(Object.entries(nodesWithClasses)
    .map(([token, block]) => [token, { block, getAttrs: blockAttrs }])),
  heading: { block: 'heading', getAttrs: token => ({ ...blockAttrs(token), level: Number(token.tag[1]) }) },
  fence: { block: 'code_block', getAttrs: token => ({ ...blockAttrs(token), info: token.info.trim(), markup: token.markup }) },
  code_block: { block: 'code_block', getAttrs: blockAttrs },
  hr: { node: 'horizontal_rule', getAttrs: token => ({ ...blockAttrs(token), markup: token.markup }) },
  bullet_list: { block: 'bullet_list', getAttrs: (token, tokens, index) => ({
    ...listAttrs(token, tokens, index), bullet: token.markup,
  }) },
  ordered_list: { block: 'ordered_list', getAttrs: (token, tokens, index) => ({
    ...listAttrs(token, tokens, index), order: Number(token.attrGet('start') ?? 1), markup: token.markup,
  }) },
  task_item: { block: 'task_item', getAttrs: token => ({ ...blockAttrs(token), checked: token.meta.checked }) },
  thead: { ignore: true },
  tbody: { ignore: true },
  th: { block: 'table_header', getAttrs: cellAttrs },
  td: { block: 'table_cell', getAttrs: cellAttrs },
  image: { node: 'image', getAttrs: token => ({
    src: token.attrGet('src'), title: token.attrGet('title'), alt: imageAlt(token.children ?? []),
  }) },
  hardbreak: { node: 'hard_break' },
  softbreak: { node: 'soft_break' },
  footnote_reference: { block: 'footnote_definition', getAttrs: token => ({ ...blockAttrs(token), label: token.meta.label }) },
  footnote_ref: { node: 'footnote_reference', getAttrs: token => ({ label: token.meta.label, source: token.meta.source }) },
  unresolved_footnote_ref: { node: 'footnote_reference', getAttrs: token => ({ label: token.content.slice(2, -1) }) },
  raw_source: { node: 'raw_block', getAttrs: token => ({ ...blockAttrs(token), source: token.content }) },
  em: { mark: 'em', getAttrs: token => ({ markup: token.markup }) },
  strong: { mark: 'strong', getAttrs: token => ({ markup: token.markup }) },
  s: { mark: 'strike', getAttrs: token => ({ markup: token.markup }) },
  code_inline: { mark: 'code', getAttrs: token => ({ markup: token.markup }) },
  link: { mark: 'link', getAttrs: token => ({ href: token.attrGet('href'), title: token.attrGet('title') }) },
  class_span: { mark: 'span', getAttrs: blockAttrs },
};

function tableCellSources(text: string, offset: number, range: LineRange): TableCellSource[] {
  const cells: TableCellSource[] = [];
  let start = text.startsWith('|') ? 1 : 0;
  const append = (end: number) => {
    const field = text.slice(start, end);
    const body = field.trim();
    const from = offset + (body ? start + field.length - field.trimStart().length : end);
    cells.push({ range, startOffset: from, endOffset: from + (body.length || 1), tableCell: body ? 'text' : 'empty' });
  };
  for (let pos = start; pos < text.length; pos++) {
    // Match markdown-it's table splitter. It separates cells before parsing inlines,
    // and treats a pipe immediately after a backslash as escaped.
    if (text[pos] === '|' && text[pos - 1] !== '\\') {
      append(pos);
      start = pos + 1;
    }
  }
  if (start < text.length) append(text.length);
  return cells;
}

function adaptBlockRules(
  markdownIt: MarkdownIt, cellSources: WeakMap<Token, TableCellSource>, rowBoundaries: WeakMap<Token, TableRowBoundaries>,
): void {
  wrapMarkdownRule(markdownIt.block.ruler, 'table', original => (state, start, end, silent) => {
    const index = state.tokens.length;
    if (!original(state, start, end, silent)) return false;
    const env = state.env as IParseEnvironment;
    if (silent || !env.includeChildRanges) return true;
    let cells: TableCellSource[] = [];
    let padding: TableCellSource | undefined;
    let column = 0;
    for (let cursor = index; cursor < state.tokens.length; cursor++) {
      const token = state.tokens[cursor];
      if (token.type === 'tr_open' && token.map) {
        const line = token.map[0];
        const from = state.bMarks[line] + state.tShift[line];
        const lineStart = from === 0 ? 0 : state.src.lastIndexOf('\n', from - 1) + 1;
        // The block rule sees nested quote/list prefixes and normalized line endings.
        // Convert its column back to the original file using the original line starts.
        const raw = state.src.slice(from, state.eMarks[line]);
        const fromContent = raw.trimStart();
        const offset = env.lines[line] + from - lineStart + raw.length - fromContent.length;
        const text = fromContent.trimEnd();
        const endOffset = offset + text.length;
        const afterLine = env.lines[token.map[1]];
        const closingPipe = text.endsWith('|') && text.at(-2) !== '\\';
        if (state.tokens[cursor + 1]?.type === 'td_open') {
          rowBoundaries.set(token, {
            start: text.startsWith('|') ? offset : env.lines[line] - 1,
            end: closingPipe ? endOffset - 1 : afterLine === undefined ? undefined : afterLine - 1,
          });
        }
        cells = tableCellSources(text, offset, token.map);
        padding = { range: token.map, startOffset: endOffset, endOffset, tableCell: 'padding' };
        column = 0;
      } else if (token.type === 'th_open' || token.type === 'td_open') {
        const cell = cells[column++] ?? (token.type === 'td_open' ? padding : undefined);
        if (cell) cellSources.set(token, cell);
      }
    }
    return true;
  }, ['paragraph', 'reference']);
  wrapMarkdownRule(markdownIt.block.ruler, 'reference', original => (state, start, end, silent) => {
    if (!original(state, start, end, silent)) return false;
    if (!silent) {
      const token = state.push('raw_source', '', 0);
      token.map = [start, state.line];
      token.content = state.getLines(start, state.line, state.blkIndent, false);
    }
    return true;
  });
  wrapMarkdownRule(markdownIt.block.ruler, 'footnoteDef', original => (state, start, end, silent) => {
    const index = state.tokens.length;
    if (!original(state, start, end, silent)) return false;
    if (!silent) state.tokens[index].map = [start, state.line];
    return true;
  }, ['paragraph', 'reference']);
  // Keep definitions in place, including definitions that have no references.
  markdownIt.disable('footnoteTail');
}

function keepUnresolvedFootnotes(markdownIt: MarkdownIt): void {
  const reference = /\[\^[^\] \n]+\]/y;
  // Links and the regular footnote rule already had a chance to consume the reference.
  markdownIt.inline.ruler.after('footnote_ref', 'unresolved_footnote_ref', (state, silent) => {
    // A silent call scans a link label. Leave the brackets as text there so `[a [^x]](url)` stays a link.
    if (silent || !state.src.startsWith('[^', state.pos)) return false;
    reference.lastIndex = state.pos;
    const match = reference.exec(state.src);
    if (!match || reference.lastIndex > state.posMax) return false;
    state.push('unresolved_footnote_ref', '', 0).content = match[0];
    state.pos = reference.lastIndex;
    return true;
  });
}

function adaptTaskItems(tokens: Token[]): void {
  const items: Token[] = [];
  tokens.forEach((token, index) => {
    if (token.type === 'list_item_open') {
      items.push(token);
    } else if (token.type === 'list_item_close') {
      if (items.pop()?.type === 'task_item_open') token.type = 'task_item_close';
    } else if (token.type === 'inline' && token.children?.[0]?.type === 'checkbox_input') {
      const item = tokens[index - 2];
      const checkbox = token.children.shift()!;
      item.type = 'task_item_open';
      item.meta = { ...item.meta, checked: checkbox.attrGet('checked') !== null };
      const first = token.children[0];
      if (first?.type === 'text') first.content = first.content.replace(/^[ \u00a0]/, '');
    }
  });
}

function prepareInline(token: Token, env: IParseEnvironment): void {
  if (token.type === 'text_special') token.type = 'text';
  if (token.type === 'footnote_ref' && token.meta.label == null) {
    token.meta.source = env.footnotes?.list?.[token.meta.id]?.content ?? '';
  }
  token.children?.forEach(child => prepareInline(child, env));
}

function isSupported(token: Token, supported: ReadonlySet<string>): boolean {
  return supported.has(token.type) && (token.children ?? []).every(child => isSupported(child, supported));
}

function groupTopLevel(tokens: Token[]): Token[][] {
  const groups: Token[][] = [];
  let start = 0;
  let depth = 0;
  tokens.forEach((token, index) => {
    depth += token.nesting;
    if (depth === 0) {
      groups.push(tokens.slice(start, index + 1));
      start = index + 1;
    }
  });
  if (start < tokens.length) groups.push(tokens.slice(start));
  return groups;
}

function supportedTokenTypes(): Set<string> {
  const types = new Set(['inline', 'text', 'softbreak']);
  for (const [name, spec] of Object.entries(tokenSpecs)) {
    if (spec.node || spec.noCloseToken || ['code_inline', 'code_block', 'fence'].includes(name)) {
      types.add(name);
    } else {
      types.add(`${name}_open`);
      types.add(`${name}_close`);
    }
  }
  return types;
}

/** Follow the block nodes emitted by MarkdownParser. Ignored wrappers like thead and tbody are transparent. */
function sourceTokenChildren(
  tokens: readonly Token[], cellSources: WeakMap<Token, TableCellSource>, rowBoundaries: WeakMap<Token, TableRowBoundaries>,
): readonly SourceToken[] | undefined {
  const rootType = tokenSpecs[tokens[0].type.replace(/_open$/, '')]?.block;
  if (!rootType || markdownSchema.nodes[rootType].inlineContent) return;

  const children: SourceToken[] = [];
  const stack = [children];
  for (let index = 1; index < tokens.length - 1; index++) {
    const token = tokens[index];
    const spec = tokenSpecs[token.type.replace(/_(open|close)$/, '')];
    const type = spec?.block ?? spec?.node;
    if (!type || !markdownSchema.nodes[type].isBlock) continue;
    if (token.nesting < 0) {
      stack.pop();
    } else {
      const cell = cellSources.get(token);
      const child: SourceToken = { type, range: cell?.range ?? token.map, cell, row: rowBoundaries.get(token), children: [] };
      stack.at(-1)!.push(child);
      if (token.nesting > 0) stack.push(child.children);
    }
  }
  return children;
}

function sourceBlock(
  node: Node, from: number, [startLine, endLine]: LineRange, tokens: readonly SourceToken[] | undefined,
  source: string, lines: readonly number[], token?: SourceToken,
): IMarkdownSourceBlock {
  const lineStart = lines[startLine] ?? source.length;
  const lineEnd = lines[endLine] ?? source.length;
  let startOffset = lineStart;
  let endOffset = lineEnd;
  const cell = token?.cell;
  if (cell) {
    ({ startOffset, endOffset } = cell);
  } else if (token) {
    const text = source.slice(lineStart, lineEnd).trimEnd();
    endOffset = lineStart + text.length;
    if (node.type.spec.tableRole === 'row') {
      // Surviving cells may follow the preceding row's opening pipe after a line-spanning deletion.
      startOffset += (/^[ \t>]*\|[ \t]*/.exec(text)?.[0].length ?? 0);
    }
  }
  const children: IMarkdownSourceBlock[] = [];
  if (tokens?.length === node.childCount) {
    node.forEach((child, offset, index) => {
      const childToken = tokens[index];
      if (childToken.type === child.type.name && childToken.range) {
        children.push(sourceBlock(child, from + 1 + offset, childToken.range, childToken.children, source, lines, childToken));
      }
    });
  }
  return { from, to: from + node.nodeSize, startLine, endLine, startOffset, endOffset,
    ...(cell ? { tableCell: cell.tableCell } : {}),
    ...(token?.row ? { tableRow: token.row } : {}),
    ...(children.length ? { children } : {}) };
}

function sourceLineStarts(source: string): number[] {
  return [0, ...Array.from(source.matchAll(/\r\n|\r|\n/g), match => match.index + match[0].length)];
}

interface IOriginalMarkdown {
  readonly source: string;
  readonly parsed: IParsedMarkdown;
}

const originalMarkdown = new WeakMap<Node['attrs'], IOriginalMarkdown>();

export function getOriginalMarkdown(doc: Node): IOriginalMarkdown | undefined {
  return originalMarkdown.get(doc.attrs);
}

export function createMarkdownParser(options?: IMarkdownItOptions): (source: string, includeChildRanges?: boolean) => IParsedMarkdown {
  const markdownIt = createMarkdownIt(options);
  const cellSources = new WeakMap<Token, TableCellSource>();
  const rowBoundaries = new WeakMap<Token, TableRowBoundaries>();
  adaptBlockRules(markdownIt, cellSources, rowBoundaries);
  keepUnresolvedFootnotes(markdownIt);
  const supported = supportedTokenTypes();
  markdownIt.core.ruler.push('prosemirror_source', state => {
    const env = state.env as IParseEnvironment;
    adaptTaskItems(state.tokens);
    state.tokens.forEach(token => prepareInline(token, env));
    state.tokens = groupTopLevel(state.tokens).flatMap(group => {
      const first = group[0];
      const range = first.map;
      if (group.every(token => isSupported(token, supported))) {
        env.blocks.push({ range, children: env.includeChildRanges ? sourceTokenChildren(group, cellSources, rowBoundaries) : undefined });
        return group;
      }
      env.blocks.push({ range });
      const raw = new state.Token('raw_source', '', 0);
      // A nested unknown token can depend on its surrounding syntax. Keep the entire outer block.
      raw.content = range
        ? env.source.slice(env.lines[range[0]], env.lines[range[1]] ?? env.source.length).replace(/\r\n$|\r$|\n$/, '')
        : group.map(token => token.content).join('');
      if (!range && !raw.content) {
        throw new Error(`Cannot preserve markdown-it token "${first.type}" without a source range or content`);
      }
      return [raw];
    });
  });
  const parser = new MarkdownParser(markdownSchema, markdownIt, tokenSpecs);

  return (source, includeChildRanges = false) => {
    const lines = sourceLineStarts(source);
    const env: IParseEnvironment = { source, lines, includeChildRanges, blocks: [] };
    const parsed = parser.parse(source, env);
    // ProseMirror transactions copy the document with these same attrs. Keep source
    // provenance off the public schema and out of ProseMirror JSON.
    const doc = parsed.type.create({}, parsed.content);
    const blocks: IMarkdownSourceBlock[] = [];
    if (env.blocks.length !== 0 && env.blocks.length !== doc.childCount) {
      throw new Error('Markdown token groups and document blocks do not match');
    }
    doc.forEach((node, offset, index) => {
      const block = env.blocks[index];
      if (block?.range) {
        blocks.push(sourceBlock(node, offset, block.range, block.children, source, lines));
      }
    });
    const result = { doc, blocks, includesChildRanges: includeChildRanges };
    originalMarkdown.set(doc.attrs, { source, parsed: result });
    return result;
  };
}

export const parseMarkdownWithSource = createMarkdownParser();

export function parseMarkdown(source: string): Node {
  return parseMarkdownWithSource(source).doc;
}
