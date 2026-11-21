import { Selection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

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
    event.preventDefault();
    view.dispatch(view.state.tr.setSelection(selection).setMeta('pointer', true));
    view.focus();
  }, true);
}
