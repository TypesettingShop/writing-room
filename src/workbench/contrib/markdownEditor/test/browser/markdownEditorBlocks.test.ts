// @vitest-environment node
import { baseKeymap } from 'prosemirror-commands';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import { expect, it } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { markdownSchema } from '../../../../../editor/common/markdown/schema.js';
import { serializeMarkdown } from '../../../../../editor/common/markdown/serializer.js';
import { indentMarkdownCode } from '../../browser/markdownEditorBlockStyles.js';
import { setMarkdownLink } from '../../browser/markdownEditorInline.js';
import { markdownListKeys, setMarkdownList } from '../../browser/markdownEditorLists.js';
import { editMarkdownTable, insertMarkdownTable, markdownTablePlugins as tablePlugins } from '../../browser/markdownEditorTables.js';

function apply(state: EditorState, command: Command): EditorState {
  let next = state;
  expect(command(state, transaction => { next = state.apply(transaction); })).toBe(true);
  next.doc.check();
  return next;
}

it('writes a task list and recovers the task state from Markdown', () => {
  const doc = parseMarkdown('One task');
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
  const result = apply(state, setMarkdownList('task'));
  const source = serializeMarkdown(result.doc);
  expect(source).toBe('- [ ] One task');
  expect(parseMarkdown(source).eq(result.doc)).toBe(true);
});

it('saves table row and column operations as a rectangular GFM table', () => {
  const state = EditorState.create({ doc: parseMarkdown(''), plugins: tablePlugins });
  let result = apply(state, insertMarkdownTable);
  result = apply(result, editMarkdownTable('addRow'));
  result = apply(result, editMarkdownTable('addColumn'));
  result = apply(result, editMarkdownTable('alignRight'));
  result = apply(result, editMarkdownTable('deleteRow'));
  result = apply(result, editMarkdownTable('deleteColumn'));
  const source = serializeMarkdown(result.doc);
  expect(source).toBe('|  |  |\n| --- | --- |\n|  |  |');
  expect(parseMarkdown(source).eq(result.doc)).toBe(true);
});

it('preserves classes and column alignment when the body row becomes the header', () => {
  const doc = parseMarkdown('| before | name |\n| ---: | :---: |\n| after {.cell} | **new** |\n| last | row |\n\n{.table}');
  const state = EditorState.create({ doc, plugins: tablePlugins });
  const result = apply(state, editMarkdownTable('deleteRow'));
  const source = serializeMarkdown(result.doc);
  expect(source).toBe('| after {.cell} | **new** |\n| ---: | :---: |\n| last | row |\n\n{.table}');
  expect(result.selection.$head.parent.type.name).toBe('table_header');
  expect(parseMarkdown(source).eq(result.doc)).toBe(true);
});

it('fills a short header row at its end so the header keeps its columns', () => {
  const { table, table_row, table_header, table_cell } = markdownSchema.nodes;
  const cell = (type: typeof table_cell, text: string) => type.create(null, markdownSchema.text(text));
  // Pasted HTML loses the span of <th colspan="2">, which leaves the header one cell short.
  const pasted = table.create(null, [
    table_row.create(null, [cell(table_header, 'Title')]),
    table_row.create(null, [cell(table_cell, 'a'), cell(table_cell, 'b')]),
  ]);
  const state = EditorState.create({ doc: parseMarkdown('x'), plugins: tablePlugins });
  const result = state.apply(state.tr.insert(state.doc.content.size, pasted));
  result.doc.check();
  expect(serializeMarkdown(result.doc)).toBe('x\n\n| Title |  |\n| --- | --- |\n| a | b |');
});

it('links every selected cell without replacing the others', () => {
  const doc = parseMarkdown('| A | B |\n| --- | --- |\n| x | y |\n|  | w |');
  const state = EditorState.create({ doc, plugins: tablePlugins });
  const cellAt = (row: number, column: number) => {
    let position = -1;
    doc.descendants((node, pos, parent, index) => {
      if (parent?.type.name === 'table_row' && doc.resolve(pos).index(-1) === row && index === column) position = pos;
    });
    return doc.resolve(position);
  };
  // The empty cell is the head cell, which is the selection's main range.
  const selected = state.apply(state.tr.setSelection(new CellSelection(cellAt(1, 1), cellAt(2, 0))));
  const result = apply(selected, setMarkdownLink('https://example.com'));
  expect(serializeMarkdown(result.doc)).toBe(
    '| A | B |\n| --- | --- |\n| [x](https://example.com) | [y](https://example.com) |\n|  | [w](https://example.com) |');
});

it('selects and then deletes a table with Backspace from the paragraph after it', () => {
  const doc = parseMarkdown('| A | B |\n| --- | --- |\n| x | y |\n\npara');
  const state = EditorState.create({ doc, plugins: tablePlugins, selection: TextSelection.create(doc, doc.firstChild!.nodeSize + 1) });
  const selected = apply(state, baseKeymap.Backspace);
  expect(selected.selection).toBeInstanceOf(NodeSelection);
  expect(serializeMarkdown(apply(selected, baseKeymap.Backspace).doc)).toBe('para');
});

it('inserts a table beside or inside a paragraph wherever the caret is', () => {
  for (const [source, position, expected] of [
    ['Hello', 6, 'Hello\n\n|  |  |\n| --- | --- |\n|  |  |'],
    ['Hello', 1, '|  |  |\n| --- | --- |\n|  |  |\n\nHello'],
    ['a **bold** b', 5, 'a **bo**\n\n|  |  |\n| --- | --- |\n|  |  |\n\n**ld** b'],
  ] as const) {
    const doc = parseMarkdown(source);
    const result = apply(EditorState.create({ doc, selection: TextSelection.create(doc, position) }), insertMarkdownTable);
    expect(serializeMarkdown(result.doc)).toBe(expected);
    expect(result.selection.$head.parent.type.name).toBe('table_header');
    expect([result.selection.$head.index(-2), result.selection.$head.index(-1)]).toEqual([0, 0]);
  }
});

it('opens an empty item above when Enter is pressed at the start of an item', () => {
  for (const [source, expected] of [
    ['- [x] Done task', '- [ ]\n- [x] Done task'],
    ['- Item {.important}', '- \n- Item {.important}'],
  ] as const) {
    const doc = parseMarkdown(source);
    let position = 0;
    doc.descendants((node, pos) => {
      if (!position && node.isTextblock) position = pos + 1;
    });
    const result = apply(EditorState.create({ doc, selection: TextSelection.create(doc, position) }), markdownListKeys.Enter);
    expect(serializeMarkdown(result.doc)).toBe(expected);
  }
});


it('indents selected code lines and excludes the line at the selection end', () => {
  const doc = parseMarkdown('```\none\ntwo\nthree\n```');
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 9) });
  const indented = apply(state, indentMarkdownCode(false));
  expect(indented.doc.textContent).toBe('    one\n    two\nthree');
  expect(apply(indented, indentMarkdownCode(true)).doc.eq(doc)).toBe(true);
});

it('outdents one literal tab or up to four spaces and lets non-code blocks use Tab normally', () => {
  const doc = parseMarkdown('Body\n\n```\n\tfirst\n  second\n     third\n```');
  const start = doc.firstChild!.nodeSize + 1;
  const selection = TextSelection.create(doc, start, doc.content.size - 1);
  const outdented = apply(EditorState.create({ doc, selection }), indentMarkdownCode(true));
  expect(outdented.doc.lastChild!.textContent).toBe('first\nsecond\n third');
  expect(indentMarkdownCode(false)(EditorState.create({ doc }))).toBe(false);
});
