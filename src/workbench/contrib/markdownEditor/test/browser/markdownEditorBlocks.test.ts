// @vitest-environment node
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { expect, it } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { serializeMarkdown } from '../../../../../editor/common/markdown/serializer.js';
import { setMarkdownList } from '../../browser/markdownEditorLists.js';
import { editMarkdownTable, insertMarkdownTable } from '../../browser/markdownEditorTables.js';

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
  const state = EditorState.create({ doc: parseMarkdown('') });
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
