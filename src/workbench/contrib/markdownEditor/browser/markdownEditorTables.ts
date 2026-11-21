import type { Node } from 'prosemirror-model';
import { Plugin, TextSelection } from 'prosemirror-state';
import type { Command, Transaction } from 'prosemirror-state';
import {
  addColumnAfter, addRowAfter, cellAround, deleteColumn, deleteRow, deleteTable, goToNextCell, isInTable,
  selectedRect, TableMap, tableEditing,
} from 'prosemirror-tables';
import { markdownSchema } from '../../../../editor/common/markdown/schema.js';

const { table, table_row, table_cell, table_header } = markdownSchema.nodes;

export const markdownTableEditing = tableEditing();

export const markdownTableFormat = new Plugin({
  appendTransaction(_transactions, oldState, state) {
    if (oldState.doc === state.doc) return;
    const before = oldState.doc.content;
    const after = state.doc.content;
    const start = before.findDiffStart(after);
    if (start === null) return;
    const end = before.findDiffEnd(after)!.b;
    const tr = state.tr;
    state.doc.nodesBetween(start, Math.max(start, end), (node, pos) => {
      if (node.type !== table) return true;
      // The table plugin repairs missing cells. GFM also requires a header row and one alignment per column.
      const header = node.firstChild!;
      node.forEach((row, rowOffset, rowIndex) => {
        const type = rowIndex === 0 ? table_header : table_cell;
        row.forEach((cell, cellOffset, column) => {
          const align = header.maybeChild(column)?.attrs.align ?? null;
          if (cell.type !== type || cell.attrs.align !== align) {
            tr.setNodeMarkup(pos + rowOffset + cellOffset + 2, type, { ...cell.attrs, align });
          }
        });
      });
      return false;
    });
    return tr.docChanged ? tr : undefined;
  },
});

function selectCell(tr: Transaction, tableStart: number, row: number, column: number): Transaction {
  const map = TableMap.get(tr.doc.nodeAt(tableStart - 1)!);
  const offset = map.map[Math.min(row, map.height - 1) * map.width + Math.min(column, map.width - 1)];
  return tr.setSelection(TextSelection.create(tr.doc, tableStart + offset + 1)).scrollIntoView();
}

export const insertMarkdownTable: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if (cellAround($from) || cellAround($to)) return false;
  const node = table.create(null, [table_header, table_cell].map(type => table_row.create(null,
    [type.create(), type.create()])));
  // The table may land before or after the caret's paragraph, outside the old selection, so look
  // for it in the range the insertion step wrote.
  const tr = state.tr.replaceSelectionWith(node, false);
  let inserted: number | undefined;
  tr.mapping.maps.at(-1)?.forEach((_from, _to, newFrom, newTo) => {
    tr.doc.nodesBetween(newFrom, newTo, (candidate, pos) => {
      if (inserted === undefined && candidate.type === table) inserted = pos;
      return inserted === undefined && !candidate.isTextblock;
    });
  });
  if (inserted === undefined) return false;
  dispatch?.(selectCell(tr, inserted + 1, 0, 0));
  return true;
};

const alignments = { alignLeft: 'left', alignCenter: 'center', alignRight: 'right', clearAlignment: null } as const;
type AlignmentEdit = keyof typeof alignments;

export type TableEdit = 'addRow' | 'deleteRow' | 'addColumn' | 'deleteColumn' | 'deleteTable' | AlignmentEdit;

export function editMarkdownTable(edit: TableEdit): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const { map, tableStart, top, bottom, left, right } = rect;
    if (edit === 'deleteTable' || (edit === 'deleteRow' && bottom - top === map.height) ||
      (edit === 'deleteColumn' && right - left === map.width)) {
      return deleteTable(state, dispatch);
    }

    const finish = (row: number, column: number) => dispatch && ((tr: Transaction) => {
      dispatch(selectCell(tr, tableStart, row, column));
    });
    switch (edit) {
      case 'addRow': return addRowAfter(state, finish(bottom, left));
      case 'deleteRow': return deleteRow(state, finish(top, left));
      case 'addColumn': return addColumnAfter(state, finish(top, right));
      case 'deleteColumn': return deleteColumn(state, finish(top, left));
    }

    if (dispatch) {
      const tr = state.tr;
      const align = alignments[edit];
      for (let row = 0; row < map.height; row++) {
        for (let col = left; col < right; col++) {
          const pos = tableStart + map.map[row * map.width + col];
          const cell = state.doc.nodeAt(pos)!;
          if (cell.attrs.align !== align) tr.setNodeMarkup(pos, undefined, { ...cell.attrs, align });
        }
      }
      dispatch(selectCell(tr, tableStart, top, left));
    }
    return true;
  };
}

export function moveMarkdownTableCell(direction: -1 | 1): Command {
  const move = goToNextCell(direction);
  return (state, dispatch, view) => {
    if (!isInTable(state)) return false;
    move(state, dispatch && (tr => dispatch(tr.setSelection(TextSelection.create(tr.doc, tr.selection.from)))), view);
    // Keep Tab inside the editor at both ends of a table.
    return true;
  };
}
