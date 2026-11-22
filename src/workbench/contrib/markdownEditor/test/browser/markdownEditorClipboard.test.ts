// @vitest-environment jsdom
import { AllSelection, EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import type { Selection, Transaction } from 'prosemirror-state';
import { DOMParser } from 'prosemirror-model';
import type { Slice } from 'prosemirror-model';
import { CellSelection } from 'prosemirror-tables';
import { EditorView } from 'prosemirror-view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { markdownSchema } from '../../../../../editor/common/markdown/schema.js';
import { readTabStorage, writeTabStorage } from '../../../../services/storage/browser/storageService.js';
import { copyMarkdownFragment, markdownClipboard, markdownClipboardEvents, pasteFromMarkdownClipboard } from '../../browser/markdownEditorClipboard.js';
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

  it('pastes the Markdown of the last copy as its visible text in plain mode, also after a reload', async () => {
    const source = parseMarkdown('[***~~안녕~~***]{.underline} `코드` [링크](https://example.test/)\n\n- 첫 항목\n- 둘째');
    const markdown = markdownClipboard.clipboardTextSerializer!(source.slice(0, source.content.size), view);
    expect(markdown).toContain('{.underline}');
    const context = parseMarkdown('x').resolve(1);
    const lines = (slice: Slice) => Array.from({ length: slice.content.childCount }, (_, i) => slice.content.child(i).textContent);
    const visible = ['안녕 코드 링크', '첫 항목', '둘째'];
    expect(lines(markdownClipboard.clipboardTextParser!(markdown, context, true, view))).toEqual(visible);
    expect(lines(markdownClipboard.clipboardTextParser!(markdown.replaceAll('\n', '\r\n'), context, true, view))).toEqual(visible);
    expect(lines(markdownClipboard.clipboardTextParser!(markdown + ' ', context, true, view))[0]).toContain('{.underline}');
    // A regular paste of the same text still parses the Markdown.
    const regular = markdownClipboard.clipboardTextParser!(markdown, context, false, view);
    expect(regular.content.firstChild!.type.name).toBe('paragraph');
    expect(regular.content.child(1).type.name).toBe('bullet_list');

    vi.resetModules();
    const reloaded = await import('../../browser/markdownEditorClipboard.js');
    expect(lines(reloaded.markdownClipboard.clipboardTextParser!(markdown, context, true, view))).toEqual(visible);
    writeTabStorage(window, 'writing-room:markdownEditor:lastCopy', undefined);
    vi.resetModules();
    const cleared = await import('../../browser/markdownEditorClipboard.js');
    expect(lines(cleared.markdownClipboard.clipboardTextParser!(markdown, context, true, view))[0]).toContain('{.underline}');
  });

  it('keeps the last copy when a selection drag serializes the selection, and updates it for the next copy', () => {
    const copy = (markdown: string) => {
      const source = parseMarkdown(markdown);
      return markdownClipboard.clipboardTextSerializer!(source.slice(0, source.content.size), view);
    };
    const context = parseMarkdown('x').resolve(1);
    const pasted = (markdown: string) => {
      const slice = markdownClipboard.clipboardTextParser!(markdown, context, true, view);
      return slice.content.textBetween(0, slice.content.size, '\n');
    };
    const first = copy('**첫 글**');
    // ProseMirror's dragstart serializes the selection through the same property as a copy.
    markdownClipboardEvents.dragstart!(view, new Event('dragstart') as DragEvent);
    const dragged = copy('*둘째 글*');
    expect(dragged).toBe('*둘째 글*');
    expect(pasted(first)).toBe('첫 글');
    expect(readTabStorage(window, 'writing-room:markdownEditor:lastCopy')).toBe(JSON.stringify({ markdown: first, text: '첫 글' }));
    // The guard ends with the drag event, so the next copy is remembered again.
    return Promise.resolve().then(() => {
      const next = copy('*셋째 글*');
      expect(pasted(next)).toBe('셋째 글');
      expect(pasted(first)).toBe(first);
    });
  });

  it('keeps the last copy only in memory when its serialized bytes exceed the session storage limit', () => {
    const key = 'writing-room:markdownEditor:lastCopy';
    const small = parseMarkdown('**small**');
    markdownClipboard.clipboardTextSerializer!(small.slice(0, small.content.size), view);
    expect(readTabStorage(window, key)).toBeDefined();

    const visible = '글'.repeat(180_000);
    const large = parseMarkdown(`**${visible}**`);
    const markdown = markdownClipboard.clipboardTextSerializer!(large.slice(0, large.content.size), view);
    expect(readTabStorage(window, key) === undefined).toBe(true);
    const plain = markdownClipboard.clipboardTextParser!(markdown, parseMarkdown('x').resolve(1), true, view);
    expect(plain.content.firstChild!.textContent === visible).toBe(true);
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

describe('Markdown context menu plain-text paste', () => {
  let view: EditorView;
  beforeEach(() => { view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc: parseMarkdown('') }) }); });
  afterEach(() => {
    view.destroy();
    delete (window.navigator as { clipboard?: Clipboard }).clipboard;
  });

  const copied = (markdown: string) => {
    const source = new EditorView(document.createElement('div'), {
      state: EditorState.create({ doc: parseMarkdown(markdown) }), ...markdownClipboard,
    });
    try {
      const { dom, text } = source.serializeForClipboard(new AllSelection(source.state.doc).content());
      return { html: dom.innerHTML, text };
    } finally {
      source.destroy();
    }
  };
  const item = (data: Record<string, string>) => ({
    types: Object.keys(data),
    getType: async (type: string) => new Blob([data[type]], { type }),
  }) as unknown as ClipboardItem;
  // jsdom has no ClipboardEvent for ProseMirror's plain-text paste, so record the text it receives.
  const paste = async (clipboard: Partial<Clipboard>) => {
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: clipboard });
    const pasted: string[] = [];
    vi.spyOn(view, 'pasteText').mockImplementation(text => { pasted.push(text); return true; });
    await pasteFromMarkdownClipboard(view, () => true, true);
    return pasted;
  };

  it('pastes the visible text of an editor copy without the whitespace around or between its blocks', async () => {
    const { html, text } = copied('**first**\n\nsecond');
    const readText = async () => text;
    const wrapped = `<html><body>\r\n<!--StartFragment-->${html}<!--EndFragment-->\r\n</body>\r\n</html>`;
    expect(await paste({ read: async () => [item({ 'text/plain': text, 'text/html': wrapped })], readText })).toEqual(['first\nsecond']);
    const indented = html.replaceAll('</p><', '</p>\n  <');
    expect(await paste({ read: async () => [item({ 'text/plain': text, 'text/html': indented })], readText })).toEqual(['first\nsecond']);
  });

  // Run the parser as the real `pasteText` does, outside code blocks, so a second resolution of the text shows.
  const pasteThroughParser = async (clipboard: Partial<Clipboard>) => {
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: clipboard });
    const pasted: string[] = [];
    vi.spyOn(view, 'pasteText').mockImplementation(text => {
      const slice = markdownClipboard.clipboardTextParser!(text, view.state.doc.resolve(1), true, view);
      pasted.push(slice.content.textBetween(0, slice.content.size, '\n'));
      return true;
    });
    await pasteFromMarkdownClipboard(view, () => true, true);
    return pasted;
  };

  it('resolves text/plain that equals the last copy to its visible text, as in a code block', async () => {
    const { text } = copied('**굵게**');
    expect(text).toBe('**굵게**');
    // A Copy as Markdown holds only text/plain. ProseMirror's code block paste never calls clipboardTextParser.
    expect(await paste({ read: async () => [item({ 'text/plain': text })] })).toEqual(['굵게']);
    expect(await paste({ readText: async () => text })).toEqual(['굵게']);
    expect(await paste({ readText: async () => `${text} ` })).toEqual([`${text} `]);
  });

  it('does not resolve the visible text of a copy again against an earlier copy', async () => {
    const { text: earlier } = copied('**굵게**');
    // The copy from another tab shows its asterisks as text, so its visible text equals the earlier Markdown.
    const other = copied('\\*\\*굵게\\*\\*');
    expect(other.text).toBe('\\*\\*굵게\\*\\*');
    copied('**굵게**');
    expect(await pasteThroughParser({ read: async () => [item({ 'text/plain': other.text, 'text/html': other.html })] }))
      .toEqual([earlier]);
    expect(await pasteThroughParser({ read: async () => [item({ 'text/plain': earlier })] })).toEqual(['굵게']);
  });

  it('pastes other clipboard text literally and reads it without clipboard.read', async () => {
    expect(await paste({ read: async () => [item({ 'text/plain': '**글**', 'text/html': '<b>글</b>' })] })).toEqual(['**글**']);
    expect(await paste({ readText: async () => '**글**' })).toEqual(['**글**']);
  });

  it('pastes image alt text in place of images and omits images without alt text', async () => {
    const { html, text } = copied('앞 ![대체 글자](photo.png) 뒤\n\n![](blank.png)문장');
    expect(await paste({ read: async () => [item({ 'text/plain': text, 'text/html': html })] }))
      .toEqual(['앞 대체 글자 뒤\n문장']);
    const plain = markdownClipboard.clipboardTextParser!(text, parseMarkdown('x').resolve(1), true, view);
    expect(plain.content.textBetween(0, plain.content.size, '\n')).toBe('앞 대체 글자 뒤\n문장');

    const withoutAlt = copied('![](blank.png)');
    expect(await paste({ read: async () => [item({ 'text/plain': withoutAlt.text, 'text/html': withoutAlt.html })] }))
      .toEqual([]);
  });

  it('does not ask for the clipboard text again after the browser refuses the clipboard read', async () => {
    const readText = vi.fn(async () => 'text');
    const read = () => Promise.reject(new DOMException('Read permission denied.', 'NotAllowedError'));
    await expect(paste({ read, readText })).rejects.toThrow('Read permission denied.');
    expect(readText).not.toHaveBeenCalled();
  });
});

describe('Markdown HTML copy', () => {
  const copyHTML = async (selection: Selection) => {
    let html = '';
    const write = async ([item]: { data: Record<string, Blob> }[]) => { html = await item.data['text/html'].text(); };
    const browserWindow = { ClipboardItem: class { constructor(readonly data: Record<string, Blob>) {} }, navigator: { clipboard: { write } } };
    await copyMarkdownFragment(browserWindow as unknown as Window, selection, 'html');
    return html;
  };

  it('copies part of a table or an ordered list as HTML with the table and the item numbers', async () => {
    const table = parseMarkdown('| *a* | b |\n| --- | --- |\n| \\# c | d |');
    const cells: number[] = [];
    table.descendants((node, pos) => { if (node.type.spec.tableRole?.endsWith('cell')) cells.push(pos); });
    const column = await copyHTML(new CellSelection(table.resolve(cells[0]), table.resolve(cells[2])));
    expect(column).toContain('<th><em>a</em></th>');
    expect(column).toContain('<td># c</td>');
    expect(column).not.toContain('<h1>');
    const list = parseMarkdown('1. one\n2. two\n3. three');
    let item = -1;
    list.descendants((node, pos) => { if (node.type.name === 'list_item' && node.textContent === 'two') item = pos; });
    expect(await copyHTML(TextSelection.create(list, item + 2, item + 4))).toBe('<ol start="2">\n<li>tw</li>\n</ol>\n');
    expect(await copyHTML(NodeSelection.create(list, item))).toBe('<ol start="2">\n<li>two</li>\n</ol>\n');
  });

  it('copies only the selected table body cells without inventing a header row', async () => {
    const doc = parseMarkdown('| title | value |\n| --- | --- |\n| *first* | one |\n| second | two |');
    const cells: number[] = [];
    doc.descendants((node, pos) => { if (node.type === markdownSchema.nodes.table_cell) cells.push(pos); });
    const text = await copyHTML(TextSelection.create(doc, cells[0] + 1, cells[0] + 6));
    expect(text).toContain('<td><em>first</em></td>');
    expect(text).not.toMatch(/<th[>\s]/);
    expect(text).not.toContain('<thead>');

    const rows = await copyHTML(new CellSelection(doc.resolve(cells[0]), doc.resolve(cells[3])));
    expect(rows).toContain('<td><em>first</em></td>');
    expect(rows).toContain('<td>two</td>');
    expect(rows.match(/<tbody>/g)).toEqual(['<tbody>']);
    expect(rows).not.toMatch(/<th[>\s]/);
    expect(rows).not.toContain('<thead>');
  });
});
