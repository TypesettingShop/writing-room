import { NodeSelection, Selection, TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
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

function textEdges(view: EditorView, bounds: DOMRect): { left: number; right: number } {
  const style = view.dom.ownerDocument.defaultView!.getComputedStyle(view.dom);
  return {
    left: bounds.left + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth),
    right: bounds.right - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderRightWidth),
  };
}

export class MarkdownEditorView extends EditorView {
  override posAtCoords(coords: { left: number; top: number }): ReturnType<EditorView['posAtCoords']> {
    const hit = super.posAtCoords(coords);
    if (!hit || !this.editable || hit.inside >= 0 || this.state.doc.resolve(hit.pos).parent.inlineContent) return hit;
    const bounds = this.dom.getBoundingClientRect();
    if (coords.left < bounds.left || coords.left > bounds.right) return hit;
    const { left, right } = textEdges(this, bounds);
    if (coords.left >= left && coords.left <= right) return hit;
    // ProseMirror's word selection needs an inline position. When the padding hit resolves
    // between blocks, use the text edge on that line and leave leaf blocks to the gutter.
    const edge = super.posAtCoords({ left: coords.left < left ? left + 1 : right - 1, top: coords.top });
    return edge && this.state.doc.resolve(edge.pos).parent.inlineContent ? edge : hit;
  }
}

export function markdownGutterCaretTransaction(
  surface: HTMLElement, view: EditorView, event: MouseEvent, extend = false, nativeTextPadding = false,
): Transaction | undefined {
  if (!isGutterTarget(surface, view, event)) return undefined;
  const { doc, schema, tr, selection: current } = view.state;
  const first = view.dom.firstElementChild?.getBoundingClientRect();
  const last = view.dom.lastElementChild?.getBoundingClientRect();
  const below = last !== undefined && event.clientY > last.bottom;
  let direction: -1 | 1;
  let selection: Selection;
  let documentEdge: number | undefined;

  if (below) {
    direction = 1;
    selection = Selection.atEnd(doc);
    documentEdge = doc.content.size;
  } else if (first && event.clientY < first.top) {
    direction = -1;
    selection = Selection.atStart(doc);
    documentEdge = 0;
  } else {
    const bounds = view.dom.getBoundingClientRect();
    const { left, right } = textEdges(view, bounds);
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

  // A press in the editor's own padding beside or above text keeps ProseMirror's handling, so a drag or
  // a double-click can still select from there. Only an atom there needs a text caret made for it.
  if (nativeTextPadding && event.target === view.dom && !below && !(selection instanceof NodeSelection)) {
    return undefined;
  }

  if (selection instanceof NodeSelection) {
    let $gap = doc.resolve(documentEdge ?? (direction < 0 ? selection.from : selection.to));
    if ($gap.depth) {
      // Nested blocks use an existing text cursor on the requested side, but only inside the same
      // top-level block: past it the nearest text can belong to an unrelated block further away.
      const found = Selection.findFrom($gap, direction, true);
      const text = found && found.$head.depth > 0 && found.$head.before(1) === $gap.before(1) ? found : null;
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
    const transaction = markdownGutterCaretTransaction(surface, view, event, event.shiftKey, true);
    if (!transaction) return;
    event.preventDefault();
    // A caret already at the clicked edge keeps its pending marks, as a click inside the text does.
    if (transaction.docChanged || !view.state.selection.eq(transaction.selection)) view.dispatch(transaction);
    if (view.editable) {
      view.focus();
    } else {
      view.dom.focus({ preventScroll: true });
      syncReadOnlyMarkdownSelection(view);
    }
  };
  return addDisposableListener(surface, 'mousedown', moveCaret, true);
}
