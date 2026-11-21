import type { Attrs, Mark, Node } from 'prosemirror-model';
import { defaultMarkdownSerializer, MarkdownSerializer } from 'prosemirror-markdown';
import type { MarkdownSerializerState } from 'prosemirror-markdown';
import { getOriginalMarkdown } from './parser.js';
import { isMarkdownClass } from './plugins/attrs.js';

const defaultNodes = defaultMarkdownSerializer.nodes;
const escapeCharacters = /[&<{|]/g;
const cellEscapeCharacters = /[&<{]/g;

function classSuffix(attrs: Attrs): string {
  const classes: string[] = attrs.classes.filter(isMarkdownClass);
  return classes.length ? '{' + classes.map(name => '.' + name).join(' ') + '}' : '';
}

function finishBlock(state: MarkdownSerializerState, node: Node): void {
  state.closeBlock(node);
  const suffix = classSuffix(node.attrs);
  if (suffix) {
    state.write(suffix);
    state.closeBlock(node);
  }
}

interface ListMarker {
  readonly type: Node['type'];
  readonly marker: string;
  readonly hasTrailer: boolean;
}

function listMarker(node: Node): ListMarker | undefined {
  const type = node.type;
  const marker = type.name === 'bullet_list' ? node.attrs.bullet
    : type.name === 'ordered_list' ? node.attrs.markup ?? '.' : undefined;
  return marker !== undefined ? { type, marker, hasTrailer: Boolean(classSuffix(node.attrs)) } : undefined;
}

function separateListMarker(current: ListMarker, previous?: ListMarker): ListMarker {
  if (previous?.type !== current.type || previous.hasTrailer || previous.marker !== current.marker) return current;
  const marker = current.type.name === 'bullet_list'
    ? current.marker === '-' ? '+' : '-'
    : current.marker === '.' ? ')' : '.';
  return { ...current, marker };
}

interface RenderedList extends ListMarker {
  readonly parent: Node;
  readonly index: number;
}

const lastListInScope = new WeakMap<MarkdownSerializerState, RenderedList>();
const looseSingleItems = new WeakMap<MarkdownSerializerState, Node>();
// Columns by which the continuation lines of the item being written sit past its content.
const itemOvershoot = new WeakMap<MarkdownSerializerState, number>();

function skipsPlaceholder(item: Node): boolean {
  // ProseMirror fills in a paragraph when a Markdown item starts with another block.
  return item.type.name === 'list_item' && item.childCount > 1 && !item.firstChild!.content.size &&
    !classSuffix(item.firstChild!.attrs) && !classSuffix(item.attrs);
}

function restore<T>(map: WeakMap<MarkdownSerializerState, T>, state: MarkdownSerializerState, value?: T): void {
  if (value === undefined) map.delete(state);
  else map.set(state, value);
}

function renderList(
  state: MarkdownSerializerState,
  node: Node,
  parent: Node,
  index: number,
  indent: number,
  firstDelim: (marker: string, itemIndex: number) => string,
): void {
  const previous = lastListInScope.get(state);
  const adjacent = previous?.parent === parent && previous.index === index - 1 ? previous : undefined;
  const current = separateListMarker(listMarker(node)!, adjacent);
  // After a skipped placeholder the list starts on the parent's marker line and inherits its overshoot.
  const outerOvershoot = itemOvershoot.get(state);
  const inherited = index === 1 && skipsPlaceholder(parent) ? outerOvershoot ?? 0 : 0;
  const item = node.firstChild!;
  const blocks = item.childCount - (skipsPlaceholder(item) ? 1 : 0);
  // Four columns past the content would turn the class line after the blank line into indented code.
  const fitsTrailer = indent - firstDelim(current.marker, 0).length + inherited < 4;
  const needsLooseTrailer = !node.attrs.tight && node.childCount === 1 && blocks === 1 && fitsTrailer;
  const outerItem = looseSingleItems.get(state);
  if (needsLooseTrailer) looseSingleItems.set(state, item);
  state.renderList(node, ' '.repeat(indent), itemIndex => {
    const delim = firstDelim(current.marker, itemIndex);
    itemOvershoot.set(state, indent - delim.length + (itemIndex === 0 ? inherited : 0));
    return delim;
  });
  restore(itemOvershoot, state, outerOvershoot);
  if (needsLooseTrailer) restore(looseSingleItems, state, outerItem);
  finishBlock(state, node);
  lastListInScope.set(state, { ...current, parent, index });
}

function isListItem(node: Node): boolean {
  return node.type.name === 'list_item' || node.type.name === 'task_item';
}

function writeCodeBlock(state: MarkdownSerializerState, node: Node): void {
  const markup: string | null = node.attrs.markup;
  const info: string = node.attrs.info;
  const marker = markup?.[0] === '~' || info.includes('`') ? '~' : '`';
  const closingFence = new RegExp('^ {0,3}(' + marker + '{3,})[ \\t]*$', 'gm');
  let size = markup?.[0] === marker ? markup.length : 3;
  for (const match of node.textContent.matchAll(closingFence)) size = Math.max(size, match[1].length + 1);

  const fence = marker.repeat(size);
  state.write(fence + info + '\n');
  if (node.content.size) {
    state.text(node.textContent, false);
    state.write('\n');
  }
  state.write(fence);
  finishBlock(state, node);
}

function encodeEntities(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');
}

function destination(href: string, title: string | null): string {
  const escaped = encodeEntities(href).replace(/[\\()<>"]/g, '\\$&');
  const url = /[ \t]/.test(href) || (!href && title !== null) ? '<' + escaped + '>' : escaped;
  return url + (title === null ? '' : ' "' + encodeEntities(title).replace(/[\\"]/g, '\\$&') + '"');
}

function inlineCodeDelimiter(text: string, markup: string | null, opening: boolean): string {
  let width = markup?.length ?? 1;
  const runs = new Set(Array.from(text.matchAll(/`+/g), run => run[0].length));
  while (runs.has(width)) width++;
  const fence = '`'.repeat(width);
  const padded = /^`|`$/.test(text) || (/^ .* $/s.test(text) && /[^ ]/.test(text));
  if (!padded) return fence;
  return opening ? fence + ' ' : ' ' + fence;
}

function emphasisDelimiter(mark: Mark, parent: Node, index: number, opening: boolean, fallback: string): string {
  const markup: string = mark.attrs.markup ?? fallback;
  if (!markup.startsWith('_')) return markup;
  let start = opening ? index : index - 1;
  let end = start + 1;
  while (start > 0 && mark.isInSet(parent.child(start - 1).marks)) start--;
  while (end < parent.childCount && mark.isInSet(parent.child(end).marks)) end++;
  const before = parent.maybeChild(start - 1)?.text?.at(-1) ?? '';
  const after = parent.maybeChild(end)?.text?.at(0) ?? '';
  const first = parent.child(start).text?.trimStart().at(0) ?? '';
  const last = parent.child(end - 1).text?.trimEnd().at(-1) ?? '';
  const word = /[\p{L}\p{N}]/u;
  return (word.test(before) && word.test(first)) || (word.test(last) && word.test(after)) ? fallback : markup;
}

function escapeTablePipes(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', '&#10;');
}

function writeTable(state: MarkdownSerializerState, node: Node): void {
  const header = node.firstChild!;
  let width = 0;
  node.forEach(row => { width = Math.max(width, row.childCount); });
  function writeRow(row: Node): void {
    state.write('|');
    for (let column = 0; column < width; column++) {
      const cell = row.maybeChild(column);
      state.write(' ');
      if (cell) {
        const paragraph = node.type.schema.nodes.paragraph.create(null, cell.content);
        const doc = node.type.schema.topNodeType.create(null, paragraph);
        // GFM separates cells before parsing inlines, even inside code or URLs.
        state.write(escapeTablePipes(tableCellSerializer.serialize(doc)));
        const suffix = classSuffix(cell.attrs);
        if (suffix) state.write((cell.content.size ? ' ' : '') + suffix);
      }
      state.write(' |');
    }
  }

  writeRow(header);
  const dividers: Record<string, string> = { left: ':---', center: ':---:', right: '---:' };
  const alignment = Array.from({ length: width }, (_, column) => dividers[header.maybeChild(column)?.attrs.align] ?? '---');
  state.write('\n');
  state.write('| ' + alignment.join(' | ') + ' |');
  for (let row = 1; row < node.childCount; row++) {
    state.write('\n');
    writeRow(node.child(row));
  }
  finishBlock(state, node);
}

const markdownSerializer = new MarkdownSerializer({
  blockquote(state, node) {
    defaultNodes.blockquote(state, node, node, 0);
    finishBlock(state, node);
  },
  paragraph(state, node, parent, index) {
    state.renderInline(node);
    const itemSuffix = isListItem(parent) && index === 0 ? classSuffix(parent.attrs) : '';
    if (itemSuffix) state.write((node.content.size ? ' ' : '') + itemSuffix);
    const suffix = classSuffix(node.attrs);
    if (suffix && node.content.size) {
      if (isListItem(parent) || parent.type.name === 'blockquote') {
        // A lone paragraph in a loose list needs the blank line before its class trailer.
        if (looseSingleItems.get(state) === parent) state.closeBlock(node);
        else state.write('\n');
        state.write(suffix);
      } else {
        state.write(' ' + suffix);
      }
    }
    state.closeBlock(node);
  },
  heading(state, node) {
    state.write('#'.repeat(node.attrs.level) + ' ');
    state.renderInline(node, false);
    const suffix = classSuffix(node.attrs);
    if (suffix) state.write((node.content.size ? ' ' : '') + suffix);
    // A terminal hash after space would otherwise become an ATX closing marker.
    const output = state as MarkdownSerializerState & { out: string };
    if (!suffix && node.content.size) output.out = output.out.replace(/([ \t])(#+)$/, '$1\\$2');
    state.closeBlock(node);
  },
  code_block: writeCodeBlock,
  horizontal_rule(state, node) {
    state.write(node.attrs.markup ?? '---');
    finishBlock(state, node);
  },
  bullet_list(state, node, parent, index) {
    renderList(state, node, parent, index, 4, marker => marker + ' ');
  },
  ordered_list(state, node, parent, index) {
    const start: number = node.attrs.order;
    const indent = Math.max(4, String(start + node.childCount - 1).length + 2);
    // A list starting above 1 cannot interrupt a paragraph without a blank line.
    if (start !== 1 && parent.maybeChild(index - 1)?.type.name === 'paragraph') state.write();
    renderList(state, node, parent, index, indent, (marker, item) => String(start + item) + marker + ' ');
  },
  list_item(state, node) {
    const skipPlaceholder = skipsPlaceholder(node);
    node.forEach((child, _offset, index) => {
      if (index !== 0 || !skipPlaceholder) state.render(child, node, index);
    });
  },
  task_item(state, node) {
    const needsSpace = Boolean(node.firstChild!.content.size || classSuffix(node.attrs));
    state.write((node.attrs.checked ? '[x]' : '[ ]') + (needsSpace ? ' ' : ''));
    state.renderContent(node);
  },
  table: writeTable,
  image(state, node) {
    const alt = state.esc(node.attrs.alt ?? '').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');
    state.write('![' + alt + '](' + destination(node.attrs.src, node.attrs.title) + ')');
  },
  hard_break: defaultNodes.hard_break,
  soft_break(state) {
    state.write('\n');
  },
  footnote_definition(state, node) {
    state.wrapBlock('    ', '[^' + node.attrs.label + ']: ', node, () => state.renderContent(node));
    finishBlock(state, node);
  },
  footnote_reference(state, node) {
    state.write(node.attrs.label === null ? '^[' + node.attrs.source + ']' : '[^' + node.attrs.label + ']');
  },
  raw_block(state, node) {
    state.text(node.attrs.source, false);
    state.closeBlock(node);
  },
  text(state, node, parent, index) {
    const previous = parent.maybeChild(index - 1);
    const next = parent.maybeChild(index + 1);
    const afterBreak = isLineBreak(previous);
    const atBlockStart = (state as MarkdownSerializerState & { atBlockStart: boolean }).atBlockStart;
    let value = state.esc(node.text!, atBlockStart || afterBreak);
    if (atBlockStart || afterBreak) {
      // Also protect ordered-list parentheses and Setext markers at line boundaries.
      value = value.replace(/^(\d{1,9})\)(?=[ \t])/, '$1\\)').replace(/^=(?==*[ \t]*$)/, '\\=');
    }
    if (index === 0 || afterBreak) value = value.replace(/^[ \t]+/, escapeBoundaryWhitespace);
    if (!next || isLineBreak(next)) value = value.replace(/[ \t]+$/, escapeBoundaryWhitespace);
    state.text(value, false);
  },
}, {
  link: {
    open: '[',
    close: (_state, mark) => '](' + destination(mark.attrs.href, mark.attrs.title) + ')',
    mixable: true,
  },
  span: {
    open: (_state, mark) => classSuffix(mark.attrs) ? '[' : '',
    close: (_state, mark) => {
      const suffix = classSuffix(mark.attrs);
      return suffix ? ']' + suffix : '';
    },
  },
  em: {
    ...defaultMarkdownSerializer.marks.em,
    open: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, true, '*'),
    close: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, false, '*'),
  },
  strong: {
    ...defaultMarkdownSerializer.marks.strong,
    open: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, true, '**'),
    close: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, false, '**'),
  },
  strike: {
    open: (_state, mark) => mark.attrs.markup ?? '~~',
    close: (_state, mark) => mark.attrs.markup ?? '~~',
    mixable: true,
    expelEnclosingWhitespace: true,
  },
  code: {
    open: (_state, mark, parent, index) => inlineCodeDelimiter(parent.child(index).text ?? '', mark.attrs.markup, true),
    close: (_state, mark, parent, index) => inlineCodeDelimiter(parent.child(index - 1).text ?? '', mark.attrs.markup, false),
    escape: false,
  },
}, { escapeExtraCharacters: escapeCharacters });

const tableCellSerializer = new MarkdownSerializer({
  ...markdownSerializer.nodes,
  paragraph: (state, node) => state.renderInline(node, false),
}, markdownSerializer.marks, { escapeExtraCharacters: cellEscapeCharacters });

function isLineBreak(node: Node | null): boolean {
  return node?.type.name === 'hard_break' || node?.type.name === 'soft_break';
}

function escapeBoundaryWhitespace(whitespace: string): string {
  return whitespace.replaceAll(' ', '&#32;').replaceAll('\t', '&#9;');
}

function referenceDefinitions(doc: Node): string[] {
  const definitions: string[] = [];
  doc.descendants(node => {
    if (node.type.name === 'raw_block' && node.attrs.source.trimStart().startsWith('[')) {
      definitions.push(node.attrs.source);
    }
    return !node.isTextblock;
  });
  return definitions;
}

interface SourcePiece {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly reusable: boolean;
}

function newlineAtEnd(text: string): string {
  return /\r\n$|\r$|\n$/.exec(text)?.[0] ?? '';
}

function endOfBlockContent(source: string, start: number, end: number): number {
  let separator = end;
  while (end > start && /[ \t\r\n]/.test(source[end - 1])) {
    const character = source[--end];
    if (character === '\n' || character === '\r') separator = end;
  }
  return separator;
}

function isClosedBlock(node: Node, block: string): boolean {
  const fence: string | null = node.type.name === 'code_block' ? node.attrs.markup : null;
  if (!fence) return true;
  // A fence at EOF can be unterminated. Close it before appending other blocks.
  const lastLine = block.split(/\r\n|\r|\n/);
  return lastLine.length > 1 && new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*$')
    .test(lastLine.at(-1)!);
}

export function serializeMarkdown(doc: Node, options: { preserveSource?: boolean } = {}): string {
  const original = options.preserveSource === false ? undefined : getOriginalMarkdown(doc);
  if (!original) return markdownSerializer.serialize(doc);
  if (doc.eq(original.parsed.doc)) return original.source;

  const { source, parsed } = original;
  const eol = /\r\n|\r|\n/.exec(source)?.[0] ?? '\n';
  const ranges = new Map(parsed.blocks.map(block => [block.from, block]));
  const pieces = new Map<Node, SourcePiece>();
  const starts: (SourcePiece | undefined)[] = [];
  parsed.doc.forEach((node, offset, index) => {
    const range = ranges.get(offset);
    if (!range) return;
    const start = range.startOffset;
    const end = endOfBlockContent(source, start, range.endOffset);
    const piece = { index, start, end, reusable: isClosedBlock(node, source.slice(start, end)) };
    pieces.set(node, piece);
    starts[index] = piece;
  });

  // Positional alignment preserves gaps around a one-for-one edit. Identity
  // anchors prevent old whitespace being assigned to reordered blocks.
  let aligned = doc.childCount === parsed.doc.childCount;
  doc.forEach((node, _offset, index) => {
    const match = pieces.get(node);
    if (match && match.index !== index) aligned = false;
  });

  const oldReferences = referenceDefinitions(parsed.doc);
  const references = referenceDefinitions(doc);
  const linksChanged = oldReferences.length !== references.length ||
    oldReferences.some((item, index) => item !== references[index]);

  const output: string[] = [];
  let previous: SourcePiece | undefined;
  let previousWasOriginal = false;
  let previousList: ListMarker | undefined;
  doc.forEach((node, _offset, index) => {
    const match = pieces.get(node);
    const raw = match ? source.slice(match.start, match.end) : '';
    const linkMayResolveDifferently = linksChanged && node.type.name !== 'raw_block' && raw.includes('[');
    const trailerMayAttach = index > 0 && match?.index === 0 && node.type.name === 'paragraph' &&
      raw.trimStart().startsWith('{.');
    const list = listMarker(node);
    const writtenList = list && separateListMarker(list, previousList);
    const differentMarker = writtenList && list?.marker !== writtenList.marker;
    const keep = Boolean(match && (match.reusable || index === doc.childCount - 1) &&
      !linkMayResolveDifferently && !trailerMayAttach && !differentMarker);
    const piece = match ?? (aligned ? starts[index] : undefined);
    const attrs = differentMarker
      ? { ...node.attrs, [node.type.name === 'bullet_list' ? 'bullet' : 'markup']: writtenList.marker }
      : null;
    const block = attrs ? node.type.create(attrs, node.content) : node;
    const text = keep ? raw : markdownSerializer.serialize(doc.type.create(null, block)).replace(/(?<!\r)\n/g, eol);
    if (!text) return;

    if (!output.length) {
      if (piece?.index === 0) output.push(source.slice(0, piece.start));
    } else {
      const gap = previous && piece?.index === previous.index + 1
        ? source.slice(previous.end, piece.start)
        : '';
      const hasBlankLine = /(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/.test(gap.replaceAll('\r\n', '\n'));
      output.push((keep && previousWasOriginal && gap) || (hasBlankLine && gap) || eol + eol);
    }
    output.push(text);
    previous = piece;
    previousWasOriginal = keep;
    previousList = writtenList;
  });

  if (!output.length) return '';
  const suffix = previous?.index === parsed.doc.childCount - 1
    ? source.slice(previous.end)
    : newlineAtEnd(source);
  output.push(suffix);
  return output.join('');
}
