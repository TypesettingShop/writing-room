// @vitest-environment node
import { readFileSync } from 'node:fs';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { serializeMarkdown } from '../../../../../editor/common/markdown/serializer.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { blockStyles, currentBlockStyle, selectedTextBlocks, setBlockStyle } from '../../browser/markdownEditorBlockStyles.js';
import { bindMarkdownFormattingContext } from '../../browser/markdownEditorFormattingContext.js';
import { linkAtSelection, normalizeMarkdownLink, setMarkdownLink, toggleInlineFormat } from '../../browser/markdownEditorInline.js';
import { currentFormattingPresets, formattingPresets, setFormattingPreset } from '../../browser/markdownEditorPresets.js';

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

  it('keeps a converted heading on one line and splits code at the blank lines Markdown reads as block breaks', () => {
    const reopen = (state: EditorState) => parseMarkdown(write(state)).content.content.map(node => node.type.name);
    for (const source of ['one\ntwo', 'one  \ntwo', '```\none\ntwo\n```']) {
      const heading = apply(read(source, 2), style('Heading 2'));
      expect(write(heading)).toBe('## one two');
      expect(reopen(heading)).toEqual(['heading']);
    }
    const body = apply(read('```\n\none\n\n\ntwo\nthree\n\n```', 2), style('Body'));
    expect(body.doc.content.content.map(node => node.type.name)).toEqual(['paragraph', 'paragraph']);
    expect(write(body)).toBe('one\n\ntwo\nthree');
    expect(reopen(body)).toEqual(['paragraph', 'paragraph']);
  });

  it('judges quotes per block across several quotes, mixed selections and quoted headings', () => {
    const all = (source: string) => {
      const doc = parseMarkdown(source);
      return EditorState.create({ doc, selection: TextSelection.create(doc, 1, doc.content.size - 1) });
    };
    expect(currentBlockStyle(all('> A\n\n> B'))).toBe('blockquote');
    expect(write(apply(all('> A\n\n> B'), style('Block Quote')))).toBe('A\n\nB');
    expect(write(apply(all('> A\n\n> B'), style('Body')))).toBe('A\n\nB');
    expect(write(apply(all('> A\n\nB'), style('Body')))).toBe('A\n\nB');
    expect(write(apply(all('> A\n\nB'), style('Block Quote')))).toBe('> A\n\n> B');
    expect(write(apply(read('> # Head', 4), style('Block Quote')))).toBe('> Head');
    expect(write(apply(read('> # Head', 4), style('Body')))).toBe('Head');
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

  function selectTextBlocks(source: string, first: string, last = first): EditorState {
    const doc = parseMarkdown(source);
    const positions = new Map<string, number>();
    doc.descendants((node, pos) => {
      if (node.isTextblock) positions.set(node.textContent, pos + 1);
    });
    const from = positions.get(first)!;
    const to = first === last ? from : positions.get(last)! + last.length;
    return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
  }

  it('replaces an alignment axis and preserves unrelated authored classes', () => {
    const state = read('Line {.my-class .center .left .size-lg}');
    const right = apply(state, setFormattingPreset('textAlign', 'right'));
    expect(write(right)).toBe('Line {.my-class .size-lg .right}');
    expect(presets(right).textAlign).toBe('right');
    expect(write(apply(right, setFormattingPreset('textAlign', 'left')))).toBe('Line {.my-class .size-lg}');
  });

  it('reads and preserves authored justify, but only offers other alignments for editing', () => {
    const state = read('Line {.center .justify .authored}');
    expect(presets(state).textAlign).toBe('justify');
    expect(setFormattingPreset('textAlign', 'justify')(read('Line'))).toBe(false);
    expect(write(state)).toBe('Line {.center .justify .authored}');
    expect(write(apply(state, setFormattingPreset('textAlign', 'center')))).toBe('Line {.authored .center}');
  });

  it('stores a left override on a quoted paragraph and preserves its parent and sibling', () => {
    const source = '> First\n>\n> Sibling\n\n{.center}';
    const state = selectTextBlocks(source, 'First');
    expect(write(state)).toBe(source);
    expect(presets(state).textAlign).toBe('center');
    // The inherited alignment needs no class of its own.
    expect(setFormattingPreset('textAlign', 'center')(state)).toBe(false);

    const left = apply(state, setFormattingPreset('textAlign', 'left'));
    const saved = write(left);
    expect(saved).toBe('> First\n> {.left}\n>\n> Sibling\n\n{.center}');
    expect(presets(selectTextBlocks(saved, 'First')).textAlign).toBe('left');
    expect(presets(selectTextBlocks(saved, 'Sibling')).textAlign).toBe('center');
    expect(setFormattingPreset('textAlign', 'left')(left)).toBe(false);

    const right = apply(left, setFormattingPreset('textAlign', 'right'));
    expect(presets(right).textAlign).toBe('right');
    expect(write(right)).toBe(saved.replace('{.left}', '{.right}'));
  });

  it('reads the nearest list alignment, a direct override and mixed selections', () => {
    const source = '- Parent {.right}\n    - Middle {.left}\n        - Inherited\n        - Direct\n            {.left .center}';
    expect(write(selectTextBlocks(source, 'Parent'))).toBe(source);
    expect(presets(selectTextBlocks(source, 'Parent')).textAlign).toBe('right');
    expect(presets(selectTextBlocks(source, 'Inherited')).textAlign).toBe('left');
    expect(presets(selectTextBlocks(source, 'Direct')).textAlign).toBe('center');
    expect(presets(selectTextBlocks(source, 'Inherited', 'Direct')).textAlign).toBeNull();
    const left = apply(selectTextBlocks(source, 'Direct'), setFormattingPreset('textAlign', 'left'));
    expect(write(left)).toBe(source.split('\n').slice(0, -1).join('\n'));
    expect(presets(left).textAlign).toBe('left');
    const right = write(apply(selectTextBlocks(source, 'Middle', 'Direct'), setFormattingPreset('textAlign', 'right')));
    for (const text of ['Middle', 'Inherited', 'Direct']) {
      expect(presets(selectTextBlocks(right, text)).textAlign).toBe('right');
    }

    // A block after an aligned container inherits from the container's parent again.
    const after = '> Quoted\n\n{.center}\n\nAfter';
    expect(presets(selectTextBlocks(after, 'Quoted', 'After')).textAlign).toBeNull();
    const both = apply(selectTextBlocks(after, 'Quoted', 'After'), setFormattingPreset('textAlign', 'left'));
    expect(write(both)).toBe('> Quoted\n> {.left}\n\n{.center}\n\nAfter');
    expect(presets(both).textAlign).toBe('left');
    expect(presets(selectTextBlocks('> Justified {.justify}', 'Justified')).textAlign).toBe('justify');
  });

  it('reports the size and font the theme renders when a block carries several of one axis', () => {
    expect(presets(read('Line {.size-24pt .size-12pt}')).fontSize).toBe('24pt');
    expect(presets(read('Line {.size-12pt .size-lg}')).fontSize).toBe('12pt');
    expect(presets(read('Line {.font-nanum-gothic .font-noto-sans-kr}')).fontFamily).toBe('nanum-gothic');
    expect(presets(read('Line {.font-mono .font-serif}')).fontFamily).toBe('monospace');
    expect(presets(read('Line {.font-mono .font-noto-serif-kr}')).fontFamily).toBe('monospace');
  });

  it('keeps the theme rules in the preset table order that the reported value relies on', () => {
    const css = readFileSync(new URL('../../browser/media/markdownTheme.css', import.meta.url), 'utf8');
    for (const { options } of Object.values(formattingPresets)) {
      const positions = options.flatMap(({ className, legacyClassName }) => [className, legacyClassName])
        .filter(name => name !== undefined)
        .map(name => css.search(new RegExp(`\\.${name}(?![\\w-])`)));
      expect(positions.every(position => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
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

  it.each([8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72])('round-trips %s pt on a heading', size => {
    const value = `${size}pt`;
    const state = read('# Line {.size-lg .authored}', 1, 5);
    const styled = apply(state, setFormattingPreset('fontSize', value));
    const source = `# Line {.authored .size-${value}}`;
    expect(write(styled)).toBe(source);
    expect(presets(read(source)).fontSize).toBe(value);
    expect(write(apply(styled, setFormattingPreset('fontSize', 'default')))).toBe('# Line {.authored}');
  });

  it('makes a whole-block choice replace inline overrides on its own axis', () => {
    const state = read('[First]{.authored .font-serif .size-xl} next {.font-sans}', 1, 11);
    expect(presets(state).fontFamily).toBeNull();
    const mono = apply(state, setFormattingPreset('fontFamily', 'monospace'));
    expect(write(mono)).toBe('[First]{.authored .size-xl} next {.font-monospace}');
    expect(presets(mono).fontFamily).toBe('monospace');
    expect(presets(mono).fontSize).toBeNull();
  });

  it.each(['noto-sans-kr', 'noto-serif-kr', 'nanum-myeongjo', 'nanum-gothic', 'monospace'])(
    'round-trips the %s font while replacing a legacy monospace class',
    font => {
      const source = 'Line {.authored .font-mono}';
      const state = read(source, 1, 5);
      expect(presets(state).fontFamily).toBe('monospace');
      expect(write(state)).toBe(source);
      const styled = apply(state, setFormattingPreset('fontFamily', font));
      const saved = `Line {.authored .font-${font}}`;
      expect(write(styled)).toBe(saved);
      expect(presets(read(saved)).fontFamily).toBe(font);
      expect(write(apply(styled, setFormattingPreset('fontFamily', 'default')))).toBe('Line {.authored}');
    },
  );

  it('applies a size and font to upcoming typing without styling the surrounding text', () => {
    const sized = apply(read('before after', 8), setFormattingPreset('fontSize', 'small'));
    const styled = apply(sized, setFormattingPreset('fontFamily', 'serif'));
    expect(write(styled)).toBe('before after');
    expect(presets(styled)).toEqual({ textAlign: 'left', fontSize: 'small', fontFamily: 'serif' });
    expect(write(styled.apply(styled.tr.insertText('new ')))).toBe('before [new ]{.size-sm .font-serif}after');
  });
});

describe('Markdown inline formats', () => {
  it.each([
    ['strong', '**word**'],
    ['em', '*word*'],
    ['strike', '~~word~~'],
    ['code', '`word`'],
  ] as const)('toggles %s and serializes the selected word', (mark, expected) => {
    const formatted = apply(read('start word end', 7, 11), toggleInlineFormat(mark));
    expect(write(formatted)).toBe(`start ${expected} end`);
    expect(write(apply(formatted, toggleInlineFormat(mark)))).toBe('start word end');
  });

  it('reflects caret changes, pending marks and code-block restrictions in pane context', () => {
    const context = new ContextKeyService();
    try {
      const update = bindMarkdownFormattingContext(context);
      const bold = read('**bold** text\n\n```\ncode\n```', 3);
      update(bold);
      expect(context.getContextKeyValue('markdownEditor.isBold')).toBe(true);
      const plain = bold.apply(bold.tr.setSelection(TextSelection.create(bold.doc, 8)));
      update(plain);
      expect(context.getContextKeyValue('markdownEditor.isBold')).toBe(false);
      update(apply(plain, toggleInlineFormat('em')));
      expect(context.getContextKeyValue('markdownEditor.isItalic')).toBe(true);
      update(read('```\ncode\n```', 2));
      expect(context.getContextKeyValue('markdownEditor.inlineFormatting')).toBe(false);
      expect(context.getContextKeyValue('markdownEditor.isItalic')).toBe(false);
      update(undefined);
      expect(context.getContextKeyValue('markdownEditor.blockType')).toBeNull();
    } finally {
      context.dispose();
    }
  });

  it('updates or removes the whole link from its caret or a sub-selection', () => {
    const state = read('A [some **marked** text](/first "title") B', 9, 12);
    expect(linkAtSelection(state)?.mark.attrs.href).toBe('/first');
    const changed = apply(state, setMarkdownLink('/notes/file name.md'));
    expect(write(changed)).toBe('A [some **marked** text](/notes/file%20name.md "title") B');
    expect(write(apply(changed, setMarkdownLink('')))).toBe('A some **marked** text B');
  });

  it('links a selection or inserts the destination at an unlinked caret', () => {
    const selected = apply(read('some text', 1, 5), setMarkdownLink('https://example.org/'));
    expect(write(selected)).toBe('[some](https://example.org/) text');
    const atCaret = apply(read('before after', 8), setMarkdownLink('/note'));
    expect(write(atCaret)).toBe('before [/note](/note)after');
  });

  it('rejects destinations the Markdown parser cannot accept', () => {
    expect(normalizeMarkdownLink('javascript:')).toBeUndefined();
    expect(normalizeMarkdownLink('java\tscript:')).toBeUndefined();
    expect(normalizeMarkdownLink('file:///example')).toBeUndefined();
    expect(normalizeMarkdownLink('  #section ')).toBe('#section');
  });
});
