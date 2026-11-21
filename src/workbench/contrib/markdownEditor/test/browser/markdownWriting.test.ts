// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { currentMarkdownHeading, markdownCounts, markdownHeadings } from '../../common/markdownWriting.js';

describe('Markdown writing information', () => {
  it('counts rendered Unicode text and whitespace in the document or selection', () => {
    const doc = parseMarkdown('# 한글 **문장**\n\nHi 😀');
    expect(markdownCounts(doc)).toEqual({ words: 4, characters: 10, nonWhitespace: 7 });
    expect(markdownCounts(doc, 4, 6)).toEqual({ words: 1, characters: 2, nonWhitespace: 2 });
    expect(markdownCounts(doc, 4, 4)).toEqual({ words: 0, characters: 0, nonWhitespace: 0 });
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
