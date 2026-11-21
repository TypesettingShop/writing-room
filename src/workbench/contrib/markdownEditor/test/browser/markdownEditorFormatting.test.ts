// @vitest-environment node
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { serializeMarkdown } from '../../../../../editor/common/markdown/serializer.js';
import { blockStyles, currentBlockStyle, setBlockStyle } from '../../browser/markdownEditorBlockStyles.js';

function read(source: string, from = 1, to = from): EditorState {
  const doc = parseMarkdown(source);
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
}

function apply(state: EditorState, command: Command): EditorState {
  let result = state;
  expect(command(state, tr => { result = state.apply(tr); })).toBe(true);
  result.doc.check();
  return result;
}

const style = (label: string) => setBlockStyle(blockStyles.find(option => option.label === label)!.value);
const write = (state: EditorState) => serializeMarkdown(state.doc);

describe('Markdown block styles', () => {
  it.each(Array.from({ length: 6 }, (_, index) => index + 1))('converts body text to Heading %s and back', level => {
    const heading = apply(read('Line {.my-class}'), style(`Heading ${level}`));
    expect(write(heading)).toBe(`${'#'.repeat(level)} Line {.my-class}`);
    expect(currentBlockStyle(heading)).toBe(`heading${level}`);
    expect(write(apply(heading, style('Body')))).toBe('Line {.my-class}');
  });

  it('stores Subtitle as a paragraph class and removes it when changing to Body', () => {
    const subtitle = apply(read('Line {.my-class}'), style('Subtitle'));
    const source = write(subtitle);
    expect(source).toBe('Line {.my-class .subtitle}');
    const reopened = read(source);
    expect(reopened.doc.firstChild?.type.name).toBe('paragraph');
    expect(currentBlockStyle(reopened)).toBe('subtitle');
    expect(write(apply(reopened, style('Body')))).toBe('Line {.my-class}');
  });

  it('wraps, lifts and reports the selected quote paragraphs', () => {
    const quoted = apply(read('Line'), style('Block Quote'));
    expect(write(quoted)).toBe('> Line');
    expect(currentBlockStyle(quoted)).toBe('blockquote');
    expect(write(apply(quoted, style('Block Quote')))).toBe('Line');
    expect(write(apply(quoted, style('Body')))).toBe('Line');
  });

  it('converts to and from fenced code while preserving line breaks and words', () => {
    const code = apply(read('one  \ntwo\nthree'), style('Code Block'));
    expect(write(code)).toBe('```\none\ntwo\nthree\n```');
    expect(currentBlockStyle(code)).toBe('code_block');
    expect(write(apply(code, style('Body')))).toBe('one\ntwo\nthree');
    expect(style('Code Block')(read('image ![description](image.png)'))).toBe(false);
  });

  it('reports mixed styles and retains each affected block’s classes during conversion', () => {
    const mixed = read('First {.one}\n\n### Second {.two}', 2, 11);
    expect(currentBlockStyle(mixed)).toBeNull();
    const result = apply(mixed, style('Heading 2'));
    expect(write(result)).toBe('## First {.one}\n\n## Second {.two}');
    expect(currentBlockStyle(result)).toBe('heading2');
  });
});
