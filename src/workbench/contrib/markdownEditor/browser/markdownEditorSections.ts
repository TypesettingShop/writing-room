import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { isEmptyMarkdownCaretParagraph } from './markdownEditorSelection.js';

export const markdownSectionsKey = new PluginKey<DecorationSet | null>('markdownSections');

export function markdownSectionStarts(doc: Node): readonly { from: number; to: number; section: number }[] {
  let section = 1;
  let needsNumber = true;
  const starts: { from: number; to: number; section: number }[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name === 'horizontal_rule') {
      section++;
      needsNumber = true;
    } else if (needsNumber && (node.type.name === 'paragraph' || node.type.name === 'heading') && !isEmptyMarkdownCaretParagraph(node)) {
      starts.push({ from: offset, to: offset + node.nodeSize, section });
      needsNumber = false;
    }
  });
  return starts;
}

function sectionNumberDecorations(doc: Node): DecorationSet {
  return DecorationSet.create(doc, markdownSectionStarts(doc).map(({ from, to, section }) =>
    Decoration.node(from, to, { 'data-markdown-section': String(section) })));
}

export function markdownSections(enabled: () => boolean): Plugin<DecorationSet | null> {
  return new Plugin({
    key: markdownSectionsKey,
    state: {
      init: (_config, state) => enabled() ? sectionNumberDecorations(state.doc) : null,
      apply: (transaction, previous) => {
        if (!enabled()) return null;
        return previous && !transaction.docChanged ? previous : sectionNumberDecorations(transaction.doc);
      },
    },
    props: {
      decorations: state => markdownSectionsKey.getState(state),
    },
  });
}
