import type { Node } from 'prosemirror-model';

export interface MarkdownCounts {
  readonly characters: number;
  readonly nonWhitespace: number;
  readonly words: number;
}

export function markdownCounts(doc: Node, from = 0, to = doc.content.size): MarkdownCounts {
  const text = doc.textBetween(from, to, '\n', node =>
    node.type.name === 'hard_break' || node.type.name === 'soft_break' ? '\n' : '');
  let characters = 0;
  let nonWhitespace = 0;
  let words = 0;
  let inWord = false;
  for (const character of text) {
    characters++;
    if (/\s/u.test(character)) {
      inWord = false;
    } else {
      nonWhitespace++;
      if (!inWord) words++;
      inWord = true;
    }
  }
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
