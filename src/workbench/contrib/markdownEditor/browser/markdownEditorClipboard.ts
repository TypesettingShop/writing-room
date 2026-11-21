import { Fragment, Slice } from 'prosemirror-model';
import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorProps } from 'prosemirror-view';
import { parseMarkdown } from '../../../../editor/common/markdown/parser.js';
import { markdownSchema } from '../../../../editor/common/markdown/schema.js';
import { serializeMarkdown } from '../../../../editor/common/markdown/serializer.js';

import { normalizeMarkdownLink } from './markdownEditorInline.js';

const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const discarded = 'script, style, template, noscript, iframe, object, embed, link, meta, base, title';
// `data-pm-slice` carries the open depth and context of a copy from this editor; ProseMirror reads it after this transform.
// Keep one GFM cell per HTML cell. Span and column-width attributes are discarded here.
const safeAttributes = new Set([
  'class', 'href', 'src', 'title', 'alt', 'start', 'data-task-checked', 'data-code-info', 'data-footnote', 'data-pm-slice',
]);
const alignments = new Set(['left', 'center', 'right', 'justify']);
// The schema reads bold and italics from these declarations (Google Docs wraps its HTML in `<b style="font-weight:normal">`).
const emphasisStyles = ['font-weight', 'font-style'] as const;

function withContextMarks(fragment: Fragment, marks: readonly Mark[]): Fragment {
  if (!marks.length) return fragment;
  const children: ProseMirrorNode[] = [];
  fragment.forEach(child => {
    let set = child.marks;
    for (const mark of marks) if (!mark.type.isInSet(set)) set = mark.addToSet(set);
    children.push(child.mark(set));
  });
  return Fragment.fromArray(children);
}

export const markdownClipboard: Pick<EditorProps, 'transformPastedHTML' | 'clipboardTextParser' | 'clipboardTextSerializer'> = {
  transformPastedHTML(html, view) {
    // Template content is inert while URLs, attributes and non-document elements are removed.
    const template = view.dom.ownerDocument.createElement('template');
    template.innerHTML = html;
    for (const element of template.content.querySelectorAll('*')) {
      if (element.namespaceURI !== htmlNamespace || element.matches(discarded)) {
        element.remove();
        continue;
      }
      const { style } = element as HTMLElement;
      const alignment = style.textAlign;
      const emphasis = emphasisStyles.map(name => [name, style.getPropertyValue(name)] as const).filter(([, value]) => value);
      for (const attribute of Array.from(element.attributes)) {
        if (!safeAttributes.has(attribute.name)) element.removeAttribute(attribute.name);
      }
      for (const name of ['href', 'src']) {
        const value = element.getAttribute(name);
        if (value !== null && !normalizeMarkdownLink(value)) element.removeAttribute(name);
      }
      for (const [name, value] of emphasis) (element as HTMLElement).style.setProperty(name, value);
      if (alignments.has(alignment)) {
        if (element.matches('th, td') && alignment !== 'justify') {
          (element as HTMLElement).style.textAlign = alignment;
        } else {
          element.classList.remove('left', 'center', 'right', 'justify');
          element.classList.add(alignment);
        }
      }
    }
    return template.innerHTML;
  },

  clipboardTextParser(text, $context, plain) {
    if (plain) {
      const { paragraph } = markdownSchema.nodes;
      const marks = $context.marks();
      const blocks = text.split(/\r\n?|\n/).map(line => paragraph.create(
        null, line ? markdownSchema.text(line, marks) : undefined,
      ));
      return Slice.maxOpen(Fragment.fromArray(blocks));
    }
    const { content, firstChild } = parseMarkdown(text);
    // A single paragraph fits at the caret. Structural Markdown keeps its outer node.
    // Inline text pasted at the caret takes the caret's marks, as ProseMirror's own text paste does.
    return content.childCount === 1 && firstChild?.type === markdownSchema.nodes.paragraph && $context.parent.inlineContent
      ? Slice.maxOpen(Fragment.from(firstChild.copy(withContextMarks(firstChild.content, $context.marks()))))
      : new Slice(content, 0, 0);
  },

  clipboardTextSerializer(slice) {
    let { content, openStart, openEnd } = slice;
    // A cell selection over the whole table copies the table, opened only at its rows.
    if (content.childCount === 1 && content.firstChild!.type === markdownSchema.nodes.table && openStart === 1 && openEnd === 1) {
      return serializeMarkdown(markdownSchema.topNodeType.create(null, content));
    }
    // A selection inside one block copies that block's text, not the markers of the blocks around it.
    while (content.childCount === 1 && openStart > 0 && openEnd > 0 && !content.firstChild!.isTextblock) {
      content = content.firstChild!.content;
      openStart--;
      openEnd--;
    }
    if (content.childCount === 1 && openStart > 0 && openEnd > 0 && content.firstChild!.isTextblock) {
      if (content.firstChild!.type.spec.code) return content.firstChild!.textContent;
      content = content.firstChild!.content;
    }
    content = content.firstChild?.isInline
      ? Fragment.from(markdownSchema.nodes.paragraph.create(null, content)) : content;
    return markdownSchema.topNodeType.validContent(content)
      ? serializeMarkdown(markdownSchema.topNodeType.create(null, content))
      : content.textBetween(0, content.size, '\n\n');
  },
};
