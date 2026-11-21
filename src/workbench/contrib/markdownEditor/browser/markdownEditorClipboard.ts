import { Fragment, Slice } from 'prosemirror-model';
import type { EditorProps } from 'prosemirror-view';
import { parseMarkdown } from '../../../../editor/common/markdown/parser.js';
import { markdownSchema } from '../../../../editor/common/markdown/schema.js';
import { serializeMarkdown } from '../../../../editor/common/markdown/serializer.js';

import { normalizeMarkdownLink } from './markdownEditorInline.js';

const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const discarded = 'script, style, template, noscript, iframe, object, embed, link, meta, base, title';
const safeAttributes = new Set(['class', 'href', 'src', 'title', 'alt', 'start', 'data-task-checked', 'data-code-info', 'data-footnote']);
const alignments = new Set(['left', 'center', 'right', 'justify']);

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
      const alignment = (element as HTMLElement).style.textAlign;
      for (const attribute of Array.from(element.attributes)) {
        if (!safeAttributes.has(attribute.name)) element.removeAttribute(attribute.name);
      }
      for (const name of ['href', 'src']) {
        const value = element.getAttribute(name);
        if (value !== null && !normalizeMarkdownLink(value)) element.removeAttribute(name);
      }
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
      const blocks = text.split(/\r\n?|\n/).map(line => paragraph.create(
        null, line ? markdownSchema.text(line) : undefined,
      ));
      return Slice.maxOpen(Fragment.fromArray(blocks));
    }
    const { content, firstChild } = parseMarkdown(text);
    // A single paragraph fits at the caret. Structural Markdown keeps its outer node.
    return content.childCount === 1 && firstChild?.type === markdownSchema.nodes.paragraph && $context.parent.inlineContent
      ? Slice.maxOpen(content) : new Slice(content, 0, 0);
  },

  clipboardTextSerializer(slice) {
    const content = slice.content.firstChild?.isInline
      ? Fragment.from(markdownSchema.nodes.paragraph.create(null, slice.content)) : slice.content;
    return markdownSchema.topNodeType.validContent(content)
      ? serializeMarkdown(markdownSchema.topNodeType.create(null, content))
      : content.textBetween(0, content.size, '\n\n');
  },
};
