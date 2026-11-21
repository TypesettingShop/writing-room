// @vitest-environment node
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { serializeMarkdown } from '../../../../../editor/common/markdown/serializer.js';
import { blockStyles, currentBlockStyle, selectedTextBlocks, setBlockStyle } from '../../browser/markdownEditorBlockStyles.js';
import { currentFormattingPresets, setFormattingPreset } from '../../browser/markdownEditorPresets.js';

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

describe('Markdown class presets', () => {
  const presets = (state: EditorState) => currentFormattingPresets(state, selectedTextBlocks(state.doc, state.selection));

  it('replaces an alignment axis and preserves unrelated authored classes', () => {
    const state = read('Line {.my-class .center .left .size-lg}');
    const right = apply(state, setFormattingPreset('textAlign', 'right'));
    expect(write(right)).toBe('Line {.my-class .size-lg .right}');
    expect(presets(right).textAlign).toBe('right');
    expect(write(apply(right, setFormattingPreset('textAlign', 'left')))).toBe('Line {.my-class .size-lg}');
  });

  it('updates only the selected part of a span and preserves the other axes and classes', () => {
    const state = read('A [word]{.authored .size-lg .font-serif} Z {.font-sans}', 4, 6);
    const large = apply(state, setFormattingPreset('fontSize', 'extraLarge'));
    expect(write(large)).toBe(
      'A [w]{.authored .size-lg .font-serif}[or]{.authored .font-serif .size-xl}[d]{.authored .size-lg .font-serif} Z {.font-sans}',
    );
    expect(presets(read(write(large), 4, 6))).toEqual({ textAlign: 'left', fontSize: 'extraLarge', fontFamily: 'serif' });
    const reset = apply(large, setFormattingPreset('fontSize', 'default'));
    expect(write(reset)).toContain('[or]{.authored .font-serif}');
    expect(presets(reset).fontSize).toBe('default');
  });

  it('makes a whole-block choice replace inline overrides on its own axis', () => {
    const state = read('[First]{.authored .font-serif .size-xl} next {.font-sans}', 1, 11);
    expect(presets(state).fontFamily).toBeNull();
    const mono = apply(state, setFormattingPreset('fontFamily', 'monospace'));
    expect(write(mono)).toBe('[First]{.authored .size-xl} next {.font-mono}');
    expect(presets(mono).fontFamily).toBe('monospace');
    expect(presets(mono).fontSize).toBeNull();
  });

  it('applies a size and font to upcoming typing without styling the surrounding text', () => {
    const sized = apply(read('before after', 8), setFormattingPreset('fontSize', 'small'));
    const styled = apply(sized, setFormattingPreset('fontFamily', 'serif'));
    expect(write(styled)).toBe('before after');
    expect(presets(styled)).toEqual({ textAlign: 'left', fontSize: 'small', fontFamily: 'serif' });
    expect(write(styled.apply(styled.tr.insertText('new ')))).toBe('before [new ]{.size-sm .font-serif}after');
  });
});
