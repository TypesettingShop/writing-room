// @vitest-environment jsdom
import { EditorState } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import { DOMParser } from 'prosemirror-model';
import type { Slice } from 'prosemirror-model';
import { CellSelection } from 'prosemirror-tables';
import { EditorView } from 'prosemirror-view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { markdownSchema } from '../../../../../editor/common/markdown/schema.js';
import { markdownClipboard } from '../../browser/markdownEditorClipboard.js';
import { markdownTablePlugins } from '../../browser/markdownEditorTables.js';

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

  it('copies a cell selection over the whole table as a GFM table', () => {
    const cells: number[] = [];
    doc.descendants((node, pos) => { if (node.type.spec.tableRole?.endsWith('cell')) cells.push(pos); });
    const selection = new CellSelection(doc.resolve(cells[0]), doc.resolve(cells.at(-1)!));
    expect(markdownClipboard.clipboardTextSerializer!(selection.content(), view)).toBe('| abc | d |\n| --- | --- |\n| e | f |');
  });

  it('marks a paste of cells into a table as a paste so it is its own undo step', () => {
    const cells: number[] = [];
    doc.descendants((node, pos) => { if (node.type.spec.tableRole?.endsWith('cell')) cells.push(pos); });
    const source = parseMarkdown('| X | Y |\n| --- | --- |\n| Z | W |');
    const sourceCells: number[] = [];
    source.descendants((node, pos) => { if (node.type.spec.tableRole?.endsWith('cell')) sourceCells.push(pos); });
    const slice = new CellSelection(source.resolve(sourceCells[0]), source.resolve(sourceCells.at(-1)!)).content();
    const dispatched: Transaction[] = [];
    const target = new EditorView(document.createElement('div'), {
      state: EditorState.create({ doc, plugins: markdownTablePlugins }),
      dispatchTransaction: tr => { dispatched.push(tr); target.updateState(target.state.apply(tr)); },
    });
    try {
      target.dispatch(target.state.tr.setSelection(new CellSelection(doc.resolve(cells[0]), doc.resolve(cells.at(-1)!))));
      dispatched.length = 0;
      const handled = target.someProp('handlePaste', handle => handle(target, new Event('paste') as ClipboardEvent, slice));
      expect(handled).toBe(true);
      const paste = dispatched.find(tr => tr.docChanged)!;
      expect(paste.getMeta('paste')).toBe(true);
      expect(paste.getMeta('uiEvent')).toBe('paste');
      expect(target.state.doc.textContent).toContain('XYZW');
    } finally {
      target.destroy();
    }
  });

  it('inherits the caret marks for regular text and omits them for plain text', () => {
    const context = parseMarkdown('a **bold** b').resolve(5);
    const regular = markdownClipboard.clipboardTextParser!('regular', context, false, view) as Slice;
    expect(regular.content.firstChild!.firstChild!.marks.map(mark => mark.type.name)).toEqual(['strong']);
    const plain = markdownClipboard.clipboardTextParser!('**literal**', context, true, view) as Slice;
    expect(plain.content.firstChild!.firstChild!.marks).toEqual([]);
    expect(plain.content.firstChild!.textContent).toBe('**literal**');
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

  it('keeps the classes of nested underline and class spans in pasted HTML', () => {
    const parser = DOMParser.fromSchema(markdownSchema);
    const classesOf = (html: string) => {
      const element = document.createElement('div');
      element.innerHTML = html;
      return parser.parse(element).firstChild!.firstChild!.marks.map(mark => mark.attrs.classes);
    };
    expect(classesOf('<p><span class="size-lg"><u>x</u></span></p>')).toEqual([['size-lg', 'underline']]);
    expect(classesOf('<p><u><strong><span class="size-lg">x</span></strong></u></p>')[0]).toEqual(['underline', 'size-lg']);
    expect(classesOf('<p><u class="keep">x</u></p>')).toEqual([['keep', 'underline']]);
  });

  it('keeps CSS underline outside links and preserves explicitly underlined links', () => {
    const html = markdownClipboard.transformPastedHTML!([
      '<p style="text-decoration:underline"><span class="size-lg"><strong>a</strong></span>',
      '<a href="/plain"><span style="text-decoration-line:underline">b</span></a>',
      '<a href="/explicit"><u>c</u></a></p>',
    ].join(''), view);
    expect(html).toBe([
      '<p><span class="size-lg"><strong><u>a</u></strong></span>',
      '<a href="/plain"><span>b</span></a>',
      '<a href="/explicit"><u>c</u></a></p>',
    ].join(''));
  });
});
