import type { Node } from 'prosemirror-model';

export interface MarkdownCounts {
  readonly characters: number;
  readonly nonWhitespace: number;
  readonly words: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const simpleGraphemes = /^[\u0000-\u007f\uac00-\ud7a3]*$/u;
const whitespace = /^\s+$/u;

interface BlockCounts extends MarkdownCounts {
  readonly endsWithCR: boolean;
}

const fullBlockCounts = new WeakMap<Node, BlockCounts>();
const sourceCacheEntries = 2048;
const sourceCacheTextLength = 512;

function visibleBreak(node: Node): string {
  return node.type.name === 'hard_break' || node.type.name === 'soft_break' ? '\n' : '';
}

function countBlock(node: Node, from: number, to: number, sourceCache?: Map<string, BlockCounts>): BlockCounts {
  const wholeBlock = from === 0 && to === node.content.size;
  const cached = wholeBlock && fullBlockCounts.get(node);
  if (cached) return cached;
  const text = node.textBetween(from, to, '\n', visibleBreak);
  const simple = simpleGraphemes.test(text) && !text.includes('\r\n');
  const sourceMemo = wholeBlock && !simple && text.length <= sourceCacheTextLength ? sourceCache : undefined;
  const memoized = sourceMemo?.get(text);
  if (memoized) {
    fullBlockCounts.set(node, memoized);
    return memoized;
  }
  const words = text.match(/\S+/g)?.length ?? 0;
  let characters = 0;
  let nonWhitespace = 0;
  if (simple) {
    // ASCII and complete Hangul syllables each take one code unit and form separate clusters here.
    characters = text.length;
    nonWhitespace = text.replace(/\s/g, '').length;
  } else {
    for (const { segment } of graphemeSegmenter.segment(text)) {
      characters++;
      if (!whitespace.test(segment)) nonWhitespace++;
    }
  }
  const counts = { characters, nonWhitespace, words, endsWithCR: text.endsWith('\r') };
  if (wholeBlock) fullBlockCounts.set(node, counts);
  if (sourceMemo) {
    if (sourceMemo.size === sourceCacheEntries) sourceMemo.delete(sourceMemo.keys().next().value!);
    sourceMemo.set(text, counts);
  }
  return counts;
}

export function markdownCounts(doc: Node, from = 0, to = doc.content.size): MarkdownCounts {
  return countDocument(doc, from, to);
}

export function createSourceMarkdownCounter(): typeof markdownCounts {
  // Monaco reparses to fresh nodes after typing stops. Reuse short complex blocks by text.
  const sourceCache = new Map<string, BlockCounts>();
  return (doc, from = 0, to = doc.content.size) => countDocument(doc, from, to, sourceCache);
}

function countDocument(doc: Node, from: number, to: number, sourceCache?: Map<string, BlockCounts>): MarkdownCounts {
  let characters = 0;
  let nonWhitespace = 0;
  let words = 0;
  let first = true;
  let endsWithCR = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return;
    const start = pos + 1;
    const counts = countBlock(
      node, Math.max(0, from - start), Math.max(0, Math.min(to - start, node.content.size)), sourceCache,
    );
    // Match textBetween's block separator, including a CRLF split across a block boundary.
    characters += counts.characters + (first || endsWithCR ? 0 : 1);
    nonWhitespace += counts.nonWhitespace;
    words += counts.words;
    first = false;
    endsWithCR = counts.endsWithCR;
    return false;
  });
  return { characters, nonWhitespace, words };
}

export interface MarkdownHeading {
  readonly level: number;
  readonly label: string;
  readonly position: number;
}

export function markdownHeadings(doc: Node): readonly MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return;
    headings.push({ level: node.attrs.level, label: node.textContent || 'Untitled heading', position: pos + 1 });
    return false;
  });
  return headings;
}

export function currentMarkdownHeading(headings: readonly MarkdownHeading[], head: number): number {
  let low = 0;
  let high = headings.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (headings[mid].position <= head) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}
