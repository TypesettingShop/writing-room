import { NodeSelection, Selection, TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

export function onMarkdownScrollbar(surface: HTMLElement, event: MouseEvent): boolean {
  const bounds = surface.getBoundingClientRect();
  return event.clientX - bounds.left - surface.clientLeft >= surface.clientWidth
    || event.clientY - bounds.top - surface.clientTop >= surface.clientHeight;
}

function isGutterTarget(surface: HTMLElement, view: EditorView, event: MouseEvent): boolean {
  return event.target === view.dom || (event.target === surface && !onMarkdownScrollbar(surface, event));
}

function isBelowContent(view: EditorView, event: MouseEvent): boolean {
  const last = view.dom.lastElementChild?.getBoundingClientRect();
  return last !== undefined && event.clientY > last.bottom;
}

export function markdownGutterSelection(surface: HTMLElement, view: EditorView, event: MouseEvent): Selection | undefined {
  if (!isGutterTarget(surface, view, event)) return undefined;
  const { doc } = view.state;
  if (isBelowContent(view, event)) return Selection.atEnd(doc);
  if (event.target !== surface) return undefined;

  const bounds = view.dom.getBoundingClientRect();
  const onLeft = event.clientX < bounds.left;
  const style = view.dom.ownerDocument.defaultView!.getComputedStyle(view.dom);
  const edge = onLeft
    ? bounds.left + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth)
    : bounds.right - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderRightWidth);
  const hit = view.posAtCoords({ left: edge + (onLeft ? 1 : -1), top: event.clientY });
  return hit ? Selection.near(doc.resolve(hit.pos), onLeft ? 1 : -1) : undefined;
}

export function markdownEndCaretTransaction(
  surface: HTMLElement, view: EditorView, event: MouseEvent, extend = false,
): Transaction | undefined {
  const { doc, schema, selection } = view.state;
  if (!view.editable || !(Selection.atEnd(doc) instanceof NodeSelection)
    || !isGutterTarget(surface, view, event) || !isBelowContent(view, event)) return undefined;

  // An atomic last block has no text cursor. Give the pointer an empty paragraph
  // after it, which only contributes to the Markdown and undo history once edited.
  const end = doc.content.size;
  const tr = view.state.tr.insert(end, schema.nodes.paragraph.create());
  const head = tr.doc.resolve(end + 1);
  const anchor = extend ? tr.doc.resolve(selection.anchor) : head;
  return tr.setSelection(TextSelection.between(anchor, head))
    .setMeta('addToHistory', false)
    .setMeta('pointer', true);
}

export function bindMarkdownGutter(surface: HTMLElement, getView: () => EditorView | undefined): IDisposable {
  const moveCaret = (event: MouseEvent) => {
    const view = getView();
    if (!view || view.composing || event.button !== 0) return;
    let transaction = markdownEndCaretTransaction(surface, view, event, event.shiftKey);
    if (!transaction) {
      let selection = markdownGutterSelection(surface, view, event);
      if (!selection) return;
      if (event.shiftKey) {
        // Shift extends the current selection to the clicked edge, as a click inside the text does.
        selection = TextSelection.between(view.state.selection.$anchor, selection.$head);
      }
      transaction = view.state.tr.setSelection(selection).setMeta('pointer', true);
    }
    event.preventDefault();
    view.dispatch(transaction);
    view.focus();
  };
  return addDisposableListener(surface, 'mousedown', moveCaret, true);
}
