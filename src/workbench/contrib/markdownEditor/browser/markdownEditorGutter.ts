import { NodeSelection, Selection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

export function onMarkdownScrollbar(surface: HTMLElement, event: MouseEvent): boolean {
  const bounds = surface.getBoundingClientRect();
  return event.clientX - bounds.left - surface.clientLeft >= surface.clientWidth
    || event.clientY - bounds.top - surface.clientTop >= surface.clientHeight;
}

export function markdownGutterSelection(surface: HTMLElement, view: EditorView, event: MouseEvent): Selection | undefined {
  const gutter = event.target === surface;
  if (gutter && onMarkdownScrollbar(surface, event)) return undefined;
  if (!gutter && event.target !== view.dom) return undefined;

  const { doc } = view.state;
  const last = view.dom.lastElementChild?.getBoundingClientRect();
  if (last !== undefined && event.clientY > last.bottom) return Selection.atEnd(doc);
  if (!gutter) return undefined;

  const bounds = view.dom.getBoundingClientRect();
  const onLeft = event.clientX < bounds.left;
  const style = view.dom.ownerDocument.defaultView!.getComputedStyle(view.dom);
  const edge = onLeft
    ? bounds.left + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth)
    : bounds.right - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderRightWidth);
  const hit = view.posAtCoords({ left: edge + (onLeft ? 1 : -1), top: event.clientY });
  return hit ? Selection.near(doc.resolve(hit.pos), onLeft ? 1 : -1) : undefined;
}

export function bindMarkdownGutter(surface: HTMLElement, getView: () => EditorView | undefined): IDisposable {
  const moveCaret = (event: MouseEvent) => {
    const view = getView();
    if (!view || view.composing || event.button !== 0) return;
    let selection = markdownGutterSelection(surface, view, event);
    if (!selection) return;
    if (event.shiftKey) {
      // Shift extends the current selection to the clicked edge, as a click inside the text does.
      selection = TextSelection.between(view.state.selection.$anchor, selection.$head);
    }
    event.preventDefault();
    view.dispatch(view.state.tr.setSelection(selection).setMeta('pointer', true));
    view.focus();
  };
  return addDisposableListener(surface, 'mousedown', moveCaret, true);
}
