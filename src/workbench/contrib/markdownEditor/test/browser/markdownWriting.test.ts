// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { createSourceMarkdownCounter, currentMarkdownHeading, markdownCounts, markdownHeadings } from '../../common/markdownWriting.js';

describe('Markdown writing information', () => {
  it('counts rendered Unicode text and whitespace in the document or selection', () => {
    const doc = parseMarkdown('# 한글 **문장**\n\nHi 😀');
    expect(markdownCounts(doc)).toEqual({ words: 4, characters: 10, nonWhitespace: 7 });
    expect(markdownCounts(doc, 4, 6)).toEqual({ words: 1, characters: 2, nonWhitespace: 2 });
    expect(markdownCounts(doc, 4, 4)).toEqual({ words: 0, characters: 0, nonWhitespace: 0 });
  });

  it('counts visible grapheme clusters across formatting and treats line breaks as whitespace', () => {
    const doc = parseMarkdown('한 한 e**́** 👩‍👩‍👧‍👦\n\nA\\\nB\nC');
    expect(markdownCounts(doc)).toEqual({ characters: 13, nonWhitespace: 7, words: 7 });
    const first = doc.firstChild!;
    expect(markdownCounts(doc, 1, first.nodeSize - 1)).toEqual({ characters: 7, nonWhitespace: 4, words: 4 });
  });

  it('counts the selected parts of blocks and the boundary between them', () => {
    const doc = parseMarkdown('a👩‍👧\n\n한b');
    const from = 2;
    const to = doc.firstChild!.nodeSize + 4;
    expect(markdownCounts(doc, from, to)).toEqual({ characters: 3, nonWhitespace: 2, words: 2 });
  });

  it('keeps counts correct across source reparses, edits and partial selections', () => {
    const count = createSourceMarkdownCounter();
    const original = parseMarkdown('👨‍👧\n\né');
    const reformatted = parseMarkdown('**👨‍👧**\n\n*é*');
    const edited = parseMarkdown('👨‍👧\n\n한 é');
    expect(count(original)).toEqual({ characters: 3, nonWhitespace: 2, words: 2 });
    expect(count(reformatted)).toEqual(count(original));
    expect(count(edited)).toEqual({ characters: 5, nonWhitespace: 3, words: 3 });
    expect(count(edited, 1, edited.firstChild!.nodeSize - 1)).toEqual({ characters: 1, nonWhitespace: 1, words: 1 });
  });

  it('finds headings at their text positions, including nested headings and skipped levels', () => {
    const doc = parseMarkdown('Intro\n\n# First\n\nSubtitle {.subtitle}\n\n> ### Nested\n\n## Second');
    const headings = markdownHeadings(doc);
    expect(headings.map(({ level, label }) => [level, label])).toEqual([[1, 'First'], [3, 'Nested'], [2, 'Second']]);
    expect(currentMarkdownHeading(headings, 1)).toBe(-1);
    expect(currentMarkdownHeading(headings, headings[1].position)).toBe(1);
    expect(currentMarkdownHeading(headings, headings[2].position - 1)).toBe(1);
  });
});
