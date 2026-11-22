import { NodeSelection, Selection, TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createMarkdownCaretParagraph, markdownCaretParagraphKey } from './markdownEditorSelection.js';

export function onMarkdownScrollbar(surface: HTMLElement, event: MouseEvent): boolean {
  const bounds = surface.getBoundingClientRect();
  return event.clientX - bounds.left - surface.clientLeft >= surface.clientWidth
    || event.clientY - bounds.top - surface.clientTop >= surface.clientHeight;
}

function isGutterTarget(surface: HTMLElement, view: EditorView, event: MouseEvent): boolean {
  return event.target === view.dom || (event.target === surface && !onMarkdownScrollbar(surface, event));
}

export function markdownGutterCaretTransaction(
  surface: HTMLElement, view: EditorView, event: MouseEvent, extend = false,
): Transaction | undefined {
  if (!isGutterTarget(surface, view, event)) return undefined;
  const { doc, schema, tr, selection: current } = view.state;
  const first = view.dom.firstElementChild?.getBoundingClientRect();
  const last = view.dom.lastElementChild?.getBoundingClientRect();
  let direction: -1 | 1;
  let selection: Selection;
  let documentEdge: number | undefined;

  if (last && event.clientY > last.bottom) {
    direction = 1;
    selection = Selection.atEnd(doc);
    documentEdge = doc.content.size;
  } else if (first && event.clientY < first.top) {
    direction = -1;
    selection = Selection.atStart(doc);
    documentEdge = 0;
  } else {
    const bounds = view.dom.getBoundingClientRect();
    const style = view.dom.ownerDocument.defaultView!.getComputedStyle(view.dom);
    const left = bounds.left + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth);
    const right = bounds.right - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderRightWidth);
    if (event.target === view.dom && event.clientX >= left && event.clientX <= right) return undefined;
    const onLeft = event.clientX < left;
    direction = onLeft ? -1 : 1;
    const hit = view.posAtCoords({ left: onLeft ? left + 1 : right - 1, top: event.clientY });
    if (!hit) return undefined;

    // The element under the probe identifies a leaf even when the browser rounds its caret to a neighbor.
    const node = hit.inside < 0 ? null : doc.nodeAt(hit.inside);
    selection = node?.isBlock && node.isAtom && NodeSelection.isSelectable(node)
      ? NodeSelection.create(doc, hit.inside)
      : Selection.near(doc.resolve(hit.pos), -direction);
  }

  if (selection instanceof NodeSelection) {
    let $gap = doc.resolve(documentEdge ?? (direction < 0 ? selection.from : selection.to));
    if ($gap.depth) {
      // Nested blocks use an existing text cursor on the requested side when possible.
      const text = Selection.findFrom($gap, direction, true);
      if (text) {
        selection = text;
      } else {
        $gap = doc.resolve(direction < 0 ? $gap.before(1) : $gap.after(1));
      }
    }
    if (selection instanceof NodeSelection) {
      const neighbor = direction < 0 ? $gap.nodeBefore : $gap.nodeAfter;
      if (neighbor?.type === schema.nodes.paragraph && neighbor.childCount === 0) {
        selection = TextSelection.create(doc, $gap.pos + direction);
      } else {
        tr.insert($gap.pos, createMarkdownCaretParagraph(schema.nodes.paragraph));
        selection = TextSelection.create(tr.doc, $gap.pos + 1);
        tr.setMeta(markdownCaretParagraphKey, true).setMeta('addToHistory', false);
      }
    }
  }

  if (extend) {
    // Shift extends the current selection to the clicked edge, as a click inside the text does.
    selection = TextSelection.between(tr.doc.resolve(tr.mapping.map(current.anchor)), selection.$head);
  }
  return tr.setSelection(selection).setMeta('pointer', true);
}

export function syncReadOnlyMarkdownSelection(view: EditorView): void {
  const { anchor, head } = view.state.selection;
  const start = view.domAtPos(anchor);
  const end = view.domAtPos(head);
  view.dom.ownerDocument.getSelection()?.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
}

export function bindMarkdownGutter(surface: HTMLElement, getView: () => EditorView | undefined): IDisposable {
  const moveCaret = (event: MouseEvent) => {
    const view = getView();
    if (!view || view.composing || event.button !== 0) return;
    // A read-only view leaves presses on its text to native selection. The gutter around it cannot take
    // focus, so a native press there would move focus to the editor group and out of the document.
    if (!view.editable && event.target !== surface) return;
    const transaction = markdownGutterCaretTransaction(surface, view, event, event.shiftKey);
    if (!transaction) return;
    event.preventDefault();
    view.dispatch(transaction);
    if (view.editable) {
      view.focus();
    } else {
      view.dom.focus({ preventScroll: true });
      syncReadOnlyMarkdownSelection(view);
    }
  };
  return addDisposableListener(surface, 'mousedown', moveCaret, true);
}
