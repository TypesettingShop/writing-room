import { NodeSelection, Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';

export const markdownActiveBlock = new Plugin({
  props: {
    decorations(state) {
      const { selection, doc } = state;
      const { $head } = selection;
      for (let depth = $head.depth; depth > 0; depth--) {
        if ($head.node(depth).isTextblock) {
          return DecorationSet.create(doc, [Decoration.node($head.before(depth), $head.after(depth), {
            'data-markdown-active-block': '',
          })]);
        }
      }
      if (selection instanceof NodeSelection && selection.node.isBlock) {
        return DecorationSet.create(doc, [Decoration.node(selection.from, selection.to, { 'data-markdown-active-block': '' })]);
      }
      return null;
    },
  },
});

export function centerMarkdownCaret(surface: HTMLElement, view: EditorView): void {
  if (!surface.clientHeight) return;
  const range = view.coordsAtPos(view.state.selection.head);
  const viewport = surface.getBoundingClientRect();
  surface.scrollTop += (range.top + range.bottom) / 2 - (viewport.top + surface.clientHeight / 2);
}
