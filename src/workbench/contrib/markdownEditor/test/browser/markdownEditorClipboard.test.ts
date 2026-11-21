// @vitest-environment jsdom
import { EditorState } from 'prosemirror-state';
import type { Slice } from 'prosemirror-model';
import { EditorView } from 'prosemirror-view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { markdownClipboard } from '../../browser/markdownEditorClipboard.js';

describe('Markdown clipboard', () => {
  let view: EditorView;
  const doc = parseMarkdown('```\nline one\n```\n\n- one two\n\n# a word b\n\n| abc | d |\n| --- | --- |\n| e | f |\n\np1 end\n\np2 start');
  const find = (text: string) => {
    let position = -1;
    doc.descendants((node, pos) => {
      if (position < 0 && node.isText && node.text!.includes(text)) position = pos + node.text!.indexOf(text);
    });
    return position;
  };
  beforeEach(() => { view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc }) }); });
  afterEach(() => view.destroy());

  it('copies text inside one block without the markers of the blocks around it', () => {
    const copy = (text: string) => markdownClipboard.clipboardTextSerializer!(doc.slice(find(text), find(text) + text.length), view);
    expect(['line one', 'two', 'word', 'bc'].map(copy)).toEqual(['line one', 'two', 'word', 'bc']);
    expect(markdownClipboard.clipboardTextSerializer!(doc.slice(find('end'), find('start') + 5), view)).toBe('end\n\np2 start');
  });

  it('gives pasted inline text the marks at the caret', () => {
    const context = parseMarkdown('a **bold** b').resolve(5);
    for (const plain of [false, true]) {
      const slice = markdownClipboard.clipboardTextParser!('plain', context, plain, view) as Slice;
      expect(slice.content.firstChild!.firstChild!.marks.map(mark => mark.type.name)).toEqual(['strong']);
    }
  });

  it('keeps emphasis declarations and the editor slice context but no other attributes', () => {
    const html = markdownClipboard.transformPastedHTML!([
      '<b style="font-weight:normal;color:red" id="x"><span style="font-weight:700">Bold</span> ',
      '<span style="font-style:italic" onclick="x()">It</span></b><p data-pm-slice="1 1 []">x</p>',
    ].join(''), view);
    expect(html).toBe([
      '<b style="font-weight: normal;"><span style="font-weight: 700;">Bold</span> ',
      '<span style="font-style: italic;">It</span></b><p data-pm-slice="1 1 []">x</p>',
    ].join(''));
  });
});
