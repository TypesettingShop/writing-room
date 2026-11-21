import { Selection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

function onScrollbar(surface: HTMLElement, event: MouseEvent): boolean {
  const bounds = surface.getBoundingClientRect();
  return event.clientX - bounds.left - surface.clientLeft >= surface.clientWidth
    || event.clientY - bounds.top - surface.clientTop >= surface.clientHeight;
}

export function bindMarkdownGutter(surface: HTMLElement, getView: () => EditorView | undefined): IDisposable {
  return addDisposableListener(surface, 'mousedown', (event: MouseEvent) => {
    const view = getView();
    if (!view || view.composing || event.button !== 0) {
      return;
    }
    const gutter = event.target === surface;
    if (!gutter && event.target !== view.dom) {
      return;
    }
    // A press on the surface's own scrollbar scrolls the document and must leave the caret alone.
    if (gutter && onScrollbar(surface, event)) {
      return;
    }
    const last = view.dom.lastElementChild?.getBoundingClientRect();
    const below = last !== undefined && event.clientY > last.bottom;
    if (!gutter && !below) {
      return;
    }

    const { doc } = view.state;
    let selection: Selection;
    if (below) {
      selection = Selection.atEnd(doc);
    } else {
      const bounds = view.dom.getBoundingClientRect();
      const onLeft = event.clientX < bounds.left;
      const style = view.dom.ownerDocument.defaultView!.getComputedStyle(view.dom);
      const edge = onLeft
        ? bounds.left + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth)
        : bounds.right - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderRightWidth);
      const hit = view.posAtCoords({ left: edge + (onLeft ? 1 : -1), top: event.clientY });
      if (!hit) {
        return;
      }
      selection = Selection.near(doc.resolve(hit.pos), onLeft ? 1 : -1);
    }
    if (event.shiftKey) {
      // Shift extends the current selection to the clicked edge, as a click inside the text does.
      selection = TextSelection.between(view.state.selection.$anchor, selection.$head);
    }
    event.preventDefault();
    view.dispatch(view.state.tr.setSelection(selection).setMeta('pointer', true));
    view.focus();
  }, true);
}
