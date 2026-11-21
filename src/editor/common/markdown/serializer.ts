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

function finishBlock(state: MarkdownSerializerState, node: Node, tight = false): void {
  state.closeBlock(node);
  const suffix = classSuffix(node.attrs);
  if (suffix) {
    if (tight) {
      (state as ListSerializerState).flushClose(1);
      if (node.type.name === 'blockquote') state.write('>\n');
    }
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
// The written marker of the list whose items are being rendered.
const renderingMarkers = new WeakMap<MarkdownSerializerState, string>();
// prosemirror-markdown's list renderer uses one continuation indent for the
// whole list. Keep its block-closing behavior while choosing the indent per item.
type ListSerializerState = MarkdownSerializerState & {
  closed: Node | null;
  inTightList: boolean;
  atBlank(): boolean;
  flushClose(size?: number): void;
};

function skipsPlaceholder(item: Node): boolean {
  // ProseMirror fills in a paragraph when a Markdown item starts with another block.
  return item.type.name === 'list_item' && item.childCount > 1 && !item.firstChild!.content.size &&
    !classSuffix(item.firstChild!.attrs) && !classSuffix(item.attrs);
}

function isBareItem(item: Node): boolean {
  // An item holding only an empty, unstyled paragraph writes nothing after its marker.
  return item.type.name === 'list_item' && item.childCount === 1 && !item.firstChild!.content.size &&
    !classSuffix(item.firstChild!.attrs) && !classSuffix(item.attrs);
}

/**
 * `run` counts the identical markers on the line up to this item's marker. It is 0 when
 * the list starts its own line.
 */
function needsRuleMarkerBreak(item: Node, marker: string, run: number, nested = false): boolean {
  // Three identical markers with nothing after them form a rule (for example, "- - -").
  if (nested && isBareItem(item)) return run >= 3;
  if (!skipsPlaceholder(item)) return false;
  const first = item.child(1);
  if (first.type.name === 'horizontal_rule') {
    // A rule on the marker line can consume the marker itself (for example, "- ---"). A nested
    // list moves such a rule to its next line, which leaves only the markers behind.
    return (first.attrs.markup ?? '---')[0] === marker && (!nested || run >= 3);
  }
  return run > 0 && first.type.name === 'bullet_list' && first.attrs.bullet === marker &&
    needsRuleMarkerBreak(first.firstChild!, marker, run + 1, true);
}

function endsWithParagraphLine(block: Node | null): boolean {
  // Paragraphs and class trailers written on their own line are paragraph text.
  return Boolean(block && (block.type.name === 'paragraph' ||
    (block.type.name !== 'heading' && classSuffix(block.attrs))));
}

function usesSetext(node: Node): boolean {
  if (node.attrs.level > 2) return false;
  for (let index = 0; index < node.childCount - 1; index++) {
    if (isLineBreak(node.child(index))) return true;
  }
  return false;
}

function renderList(
  state: MarkdownSerializerState,
  node: Node,
  parent: Node,
  index: number,
  firstDelim: (marker: string, itemIndex: number) => string,
): void {
  const previous = lastListInScope.get(state);
  const adjacent = previous?.parent === parent && previous.index === index - 1 ? previous : undefined;
  const current = separateListMarker(listMarker(node)!, adjacent);
  const listState = state as ListSerializerState;
  const item = node.firstChild!;
  // A changed marker already ends the previous list. Blank lines would make a tight parent item loose.
  if (listState.closed?.type === node.type && !listState.inTightList) {
    listState.flushClose(3);
  } else if (endsWithParagraphLine(listState.closed) && needsRuleMarkerBreak(item, current.marker, 0)) {
    // An item that starts with a blank line cannot interrupt a paragraph, so end the paragraph first.
    listState.flushClose(2);
  } else if (listState.inTightList) {
    listState.flushClose(1);
  }

  const blocks = item.childCount - (skipsPlaceholder(item) ? 1 : 0);
  const needsLooseTrailer = !node.attrs.tight && node.childCount === 1 && blocks === 1;
  const outerItem = looseSingleItems.get(state);
  const outerTight = listState.inTightList;
  if (needsLooseTrailer) looseSingleItems.set(state, item);
  const parentMarker = renderingMarkers.get(state);
  renderingMarkers.set(state, current.marker);
  listState.inTightList = node.attrs.tight;
  node.forEach((child, _offset, itemIndex) => {
    if (itemIndex && node.attrs.tight) listState.flushClose(1);
    const delim = firstDelim(current.marker, itemIndex);
    const sharesMarkerLine = isListItem(parent) && !listState.closed && !listState.atBlank();
    const run = sharesMarkerLine ? (parentMarker === current.marker ? 2 : 1) : 0;
    const firstLine = needsRuleMarkerBreak(child, current.marker, run) ? delim.trimEnd() + '\n' : delim;
    state.wrapBlock(' '.repeat(delim.length), firstLine, node, () => state.render(child, node, itemIndex));
  });
  if (parentMarker === undefined) renderingMarkers.delete(state);
  else renderingMarkers.set(state, parentMarker);
  listState.inTightList = outerTight;
  if (needsLooseTrailer) {
    if (outerItem) looseSingleItems.set(state, outerItem);
    else looseSingleItems.delete(state);
  }
  finishBlock(state, node);
  lastListInScope.set(state, { ...current, parent, index });
}

function isListItem(node: Node): boolean {
  return node.type.name === 'list_item' || node.type.name === 'task_item';
}

function isTightItem(state: MarkdownSerializerState, parent: Node): boolean {
  return isListItem(parent) && (state as ListSerializerState).inTightList;
}

function renderItemContent(state: MarkdownSerializerState, item: Node): void {
  const listState = state as ListSerializerState;
  const first = skipsPlaceholder(item) ? 1 : 0;
  for (let index = first; index < item.childCount; index++) {
    const child = item.child(index);
    if (listState.inTightList && index > first) {
      const previous = item.child(index - 1);
      const previousType = previous.type.name;
      const childType = child.type.name;
      const previousHasClasses = Boolean(classSuffix(previous.attrs));
      // Tables and Setext text can be consumed by the preceding table or nested list.
      const previousIsTableOrList = previousType === 'table' || previousType === 'bullet_list' ||
        previousType === 'ordered_list';
      const setextNeedsBlankLine = childType === 'heading' && usesSetext(child) &&
        (endsWithParagraphLine(previous) || previousIsTableOrList || previousType === 'blockquote');
      const startsWithoutBlankLine = childType === 'code_block' || (childType === 'heading' && !setextNeedsBlankLine) ||
        childType === 'horizontal_rule' || (childType === 'table' && !previousIsTableOrList) ||
        (childType === 'blockquote' && (previousType !== 'blockquote' || previousHasClasses));
      const paragraphFollowsWithoutBlankLine = childType === 'paragraph' && (previousType === 'heading' ||
        (!previousHasClasses && (previousType === 'code_block' || previousType === 'blockquote' ||
          previousType === 'horizontal_rule')));
      if (startsWithoutBlankLine || paragraphFollowsWithoutBlankLine) {
        listState.flushClose(1);
        // Paragraphs and tables can be lazy continuations of a quote.
        if (previousType === 'blockquote' && !previousHasClasses &&
          (childType === 'paragraph' || childType === 'table')) state.write('>\n');
      }
    }
    state.render(child, item, index);
  }
}

function writeCodeBlock(state: MarkdownSerializerState, node: Node, parent: Node): void {
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
  finishBlock(state, node, isTightItem(state, parent));
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
  blockquote(state, node, parent) {
    defaultNodes.blockquote(state, node, node, 0);
    finishBlock(state, node, isTightItem(state, parent));
  },
  paragraph(state, node, parent, index) {
    const itemSuffix = isListItem(parent) && index === 0 ? classSuffix(parent.attrs) : '';
    const suffix = classSuffix(node.attrs);
    const looseTrailer = looseSingleItems.get(state) === parent;
    // Trailing hard breaks write nothing, so such a paragraph is empty in Markdown too.
    let blank = true;
    node.forEach(child => { if (child.type.name !== 'hard_break') blank = false; });
    if (blank && suffix && isListItem(parent)) {
      state.write('[]' + (looseTrailer ? '{}' : suffix));
      if (itemSuffix) state.write(' ' + itemSuffix);
      if (looseTrailer) {
        state.closeBlock(node);
        state.write(suffix);
      }
      state.closeBlock(node);
      return;
    }

    state.renderInline(node);
    if (itemSuffix) state.write((node.content.size ? ' ' : '') + itemSuffix);
    if (suffix && node.content.size) {
      if (isListItem(parent) || parent.type.name === 'blockquote') {
        // A lone paragraph in a loose list needs the blank line before its class trailer.
        if (looseTrailer) state.closeBlock(node);
        else state.write('\n');
        state.write(suffix);
      } else {
        state.write(' ' + suffix);
      }
    }
    state.closeBlock(node);
  },
  heading(state, node) {
    const suffix = classSuffix(node.attrs);
    if (usesSetext(node)) {
      state.renderInline(node);
      if (suffix) state.write(' ' + suffix);
      state.write('\n');
      state.write(node.attrs.level === 1 ? '===' : '---');
      state.closeBlock(node);
      return;
    }
    state.write('#'.repeat(node.attrs.level) + ' ');
    state.renderInline(node, false);
    if (suffix) state.write((node.content.size ? ' ' : '') + suffix);
    // A terminal hash after space would otherwise become an ATX closing marker.
    const output = state as MarkdownSerializerState & { out: string };
    if (!suffix && node.content.size) output.out = output.out.replace(/([ \t])(#+)$/, '$1\\$2');
    state.closeBlock(node);
  },
  code_block: writeCodeBlock,
  horizontal_rule(state, node, parent, index) {
    const tight = isTightItem(state, parent);
    let markup: string = node.attrs.markup ?? '---';
    if (tight && /^-{3,}$/.test(markup) && index > (skipsPlaceholder(parent) ? 1 : 0)) {
      // Space the dashes so the preceding paragraph or class trailer cannot become a Setext heading.
      if (endsWithParagraphLine(parent.child(index - 1))) markup = [...markup].join(' ');
    }
    state.write(markup);
    finishBlock(state, node, tight);
  },
  bullet_list(state, node, parent, index) {
    renderList(state, node, parent, index, marker => marker + ' ');
  },
  ordered_list(state, node, parent, index) {
    const start: number = node.attrs.order;
    const previous = parent.maybeChild(index - 1);
    // A list starting above 1 cannot interrupt a paragraph, including the class line
    // written after a styled block, without a blank line.
    if (start !== 1 && endsWithParagraphLine(previous)) state.write();
    renderList(state, node, parent, index, (marker, item) => String(start + item) + marker + ' ');
  },
  list_item: renderItemContent,
  task_item(state, node) {
    const first = node.firstChild!;
    const needsSpace = Boolean(first.content.size || classSuffix(first.attrs) || classSuffix(node.attrs));
    state.write((node.attrs.checked ? '[x]' : '[ ]') + (needsSpace ? ' ' : ''));
    renderItemContent(state, node);
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
    state.wrapBlock('    ', '[^' + node.attrs.label + ']: ', node, () => node.forEach((child, _offset, index) => {
      // The definition's first line starts one column past its later lines. Lists and
      // fences measure their content from that column, so keep the whole block on it.
      if (index === 0 && ['bullet_list', 'ordered_list', 'code_block'].includes(child.type.name)) {
        state.wrapBlock(' ', '', child, () => state.render(child, node, index));
      } else {
        state.render(child, node, index);
      }
    }));
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
