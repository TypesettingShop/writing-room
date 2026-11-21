import { wrapInList, liftListItem, sinkListItem, splitListItemKeepMarks } from 'prosemirror-schema-list';
import type { Node } from 'prosemirror-model';
import type { Command, Transaction } from 'prosemirror-state';
import type { NodeView } from 'prosemirror-view';
import { markdownSchema } from '../../../../editor/common/markdown/schema.js';

const { bullet_list, ordered_list, list_item, task_item } = markdownSchema.nodes;
const items = [list_item, task_item];
const lists = [bullet_list, ordered_list];

export function convertListItems(tr: Transaction, task: boolean): Transaction {
  const { $from, $to } = tr.selection;
  const range = $from.blockRange($to, node => lists.includes(node.type));
  if (!range) return tr;
  range.parent.forEach((item, offset, index) => {
    if (index < range.startIndex || index >= range.endIndex) return;
    if (task && item.type === list_item) {
      tr.setNodeMarkup(range.$from.start(range.depth) + offset, task_item, { ...item.attrs, checked: false });
    } else if (!task && item.type === task_item) {
      tr.setNodeMarkup(range.$from.start(range.depth) + offset, list_item, item.attrs);
    }
  });
  return tr;
}

export function setMarkdownList(kind: 'bullet' | 'ordered' | 'task'): Command {
  return (state, dispatch) => {
    const type = kind === 'ordered' ? ordered_list : bullet_list;
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to, node => lists.includes(node.type));
    if (range) {
      const tr = convertListItems(state.tr, kind === 'task');
      if (kind !== 'task' && range.parent.type !== type) {
        tr.setNodeMarkup($from.before(range.depth), type, { classes: range.parent.attrs.classes, tight: range.parent.attrs.tight });
      }
      if (!tr.docChanged) return liftListItem(items)(state, dispatch);
      dispatch?.(tr.scrollIntoView());
      return true;
    }
    return wrapInList(type)(state, dispatch && (tr => dispatch(
      kind === 'task' ? convertListItems(tr, true) : tr,
    )));
  };
}

export const markdownListKeys: Record<string, Command> = {
  Tab: (state, dispatch) => sinkListItem(items)(state, dispatch) || inList(state.selection.$from),
  'Shift-Tab': (state, dispatch) => liftListItem(items)(state, dispatch) || inList(state.selection.$from),
  Enter: (state, dispatch) => {
    const { $from } = state.selection;
    if (!inList($from)) return false;
    if (state.selection.empty && $from.parent.type === markdownSchema.nodes.paragraph && !$from.parent.content.size
        && items.includes($from.node(-1).type) && $from.node(-1).childCount === 1) {
      return liftListItem(items)(state, dispatch);
    }
    return splitListItemKeepMarks(items, { checked: false })(state, dispatch);
  },
};

function inList(position: Transaction['selection']['$from']): boolean {
  for (let depth = position.depth; depth > 0; depth--) {
    if (lists.includes(position.node(depth).type)) return true;
  }
  return false;
}

export function taskItemView(
  node: Node, document: Document, toggle: (checked: boolean) => boolean, writable: () => boolean,
): NodeView {
  const dom = document.createElement('li');
  const checkbox = dom.appendChild(document.createElement('input'));
  checkbox.type = 'checkbox';
  checkbox.contentEditable = 'false';
  checkbox.setAttribute('aria-label', 'Task completed');
  checkbox.addEventListener('change', () => {
    if (!toggle(checkbox.checked)) checkbox.checked = dom.dataset.taskChecked === 'true';
  });
  const contentDOM = dom.appendChild(document.createElement('div'));
  function update(next: Node): boolean {
    if (next.type !== node.type) return false;
    dom.className = next.attrs.classes.join(' ');
    dom.dataset.taskChecked = String(next.attrs.checked);
    checkbox.checked = next.attrs.checked;
    checkbox.disabled = !writable();
    return true;
  }
  update(node);
  return { dom, contentDOM, update, stopEvent: event => event.target === checkbox };
}
