import type { Node, ResolvedPos } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { Command, Transaction } from 'prosemirror-state';
import { markdownSchema } from '../../../../editor/common/markdown/schema.js';

const { table, table_row, table_cell } = markdownSchema.nodes;

interface TablePosition {
  readonly node: Node;
  readonly pos: number;
  readonly row: number;
  readonly column: number;
}

function tablePosition($pos: ResolvedPos): TablePosition | undefined {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type !== table_cell) continue;
    return {
      node: $pos.node(depth - 2), pos: $pos.before(depth - 2),
      row: $pos.index(depth - 2), column: $pos.index(depth - 1),
    };
  }
  return undefined;
}

function cellPosition(node: Node, pos: number, row: number, column: number): number {
  let inside = pos + 3;
  for (let index = 0; index < row; index++) inside += node.child(index).nodeSize;
  for (let index = 0; index < column; index++) inside += node.child(row).child(index).nodeSize;
  return inside;
}

function selectCell(tr: Transaction, node: Node, pos: number, row: number, column: number): Transaction {
  return tr.setSelection(TextSelection.create(tr.doc, cellPosition(node, pos, row, column))).scrollIntoView();
}

export const insertMarkdownTable: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if (tablePosition($from) || tablePosition($to)) return false;
  const node = table.create(null, [true, false].map(header => table_row.create(null,
    Array.from({ length: 2 }, () => table_cell.create({ header })))));
  // The table may land before or after the caret's paragraph, outside the old selection, so look
  // for it in the range the insertion step wrote.
  const tr = state.tr.replaceSelectionWith(node, false);
  let inserted: { node: Node; pos: number } | undefined;
  tr.mapping.maps.at(-1)?.forEach((_from, _to, newFrom, newTo) => {
    tr.doc.nodesBetween(newFrom, newTo, (candidate, pos) => {
      if (!inserted && candidate.type === table) inserted = { node: candidate, pos };
      return !inserted && !candidate.isTextblock;
    });
  });
  if (!inserted) return false;
  dispatch?.(selectCell(tr, inserted.node, inserted.pos, 0, 0));
  return true;
};

export type TableEdit = 'addRow' | 'deleteRow' | 'addColumn' | 'deleteColumn' | 'deleteTable'
  | 'alignLeft' | 'alignCenter' | 'alignRight' | 'clearAlignment';

export function editMarkdownTable(edit: TableEdit): Command {
  return (state, dispatch) => {
    const current = tablePosition(state.selection.$head);
    if (!current) return false;
    const { node, pos } = current;
    const rows = Array.from({ length: node.childCount }, (_, index) => node.child(index));
    const width = Math.max(...rows.map(row => row.childCount));
    if (edit === 'deleteTable' || (edit === 'deleteRow' && rows.length === 1) || (edit === 'deleteColumn' && width === 1)) {
      dispatch?.(state.tr.delete(pos, pos + node.nodeSize).scrollIntoView());
      return true;
    }

    let { row, column } = current;
    const alignments = Array.from({ length: width }, (_, index) => rows[0].maybeChild(index)?.attrs.align ?? null);
    if (edit === 'addRow') {
      rows.splice(++row, 0, table_row.create(null, alignments.map(() => table_cell.create())));
    } else if (edit === 'deleteRow') {
      rows.splice(row, 1);
      row = Math.min(row, rows.length - 1);
    }
    const alignment = { alignLeft: 'left', alignCenter: 'center', alignRight: 'right', clearAlignment: null } as const;
    if (edit in alignment) alignments[column] = alignment[edit as keyof typeof alignment];
    if (edit === 'addColumn') alignments.splice(column + 1, 0, null);
    if (edit === 'deleteColumn') alignments.splice(column, 1);

    const replacement = table.create(node.attrs, rows.map((line, index) => {
      const cells = Array.from({ length: width }, (_, col) => line.maybeChild(col) ?? table_cell.create());
      if (edit === 'addColumn') cells.splice(column + 1, 0, table_cell.create());
      if (edit === 'deleteColumn') cells.splice(column, 1);
      return table_row.create(line.attrs, cells.map((cell, col) => table_cell.create(
        { ...cell.attrs, header: index === 0, align: alignments[col] }, cell.content,
      )));
    }));
    if (edit === 'addColumn') column++;
    column = Math.min(column, alignments.length - 1);
    const tr = state.tr.replaceWith(pos, pos + node.nodeSize, replacement);
    dispatch?.(selectCell(tr, replacement, pos, row, column));
    return true;
  };
}

export function moveMarkdownTableCell(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const current = tablePosition(state.selection.$head);
    if (!current) return false;
    const { node, pos } = current;
    let { row, column } = current;
    column += direction;
    if (column < 0 && row > 0) {
      column = node.child(--row).childCount - 1;
    } else if (column >= node.child(row).childCount && row + 1 < node.childCount) {
      row++;
      column = 0;
    }
    if (column >= 0 && column < node.child(row).childCount) {
      dispatch?.(selectCell(state.tr, node, pos, row, column));
    }
    return true;
  };
}
