import { DOMParser, Fragment, Slice } from 'prosemirror-model';
import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorProps, EditorView } from 'prosemirror-view';
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

function applyPastedUnderline(document: Document, content: DocumentFragment, underlined: ReadonlySet<Element>): void {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const container = text.parentElement;
    if (!container || container.closest('a, u')) continue;
    for (let parent: Element | null = container; parent; parent = parent.parentElement) {
      if (!underlined.has(parent)) continue;
      const underline = document.createElement('u');
      container.insertBefore(underline, text);
      underline.append(text);
      break;
    }
  }
}

function copiedFragmentText(document: Document, html: string): string | undefined {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll(discarded)) element.remove();
  // ProseMirror marks the first element of the serialized fragment, including any table wrapper.
  if (!template.content.firstElementChild?.hasAttribute('data-pm-slice')) return undefined;
  const { content } = DOMParser.fromSchema(markdownSchema).parseSlice(template.content, { preserveWhitespace: 'full' });
  return content.textBetween(0, content.size, '\n', node => node.type === markdownSchema.nodes.hard_break ? '\n' : '');
}

async function readPlainClipboardText(clipboard: Clipboard, document: Document): Promise<string> {
  // Keep literal text paste available when the richer clipboard read is unavailable.
  const items = await clipboard.read?.().catch(() => undefined);
  if (!items) return clipboard.readText();
  const plain = items.find(item => item.types.includes('text/plain'));
  const item = plain ?? items.find(item => item.types.includes('text/html'));
  if (item?.types.includes('text/html')) {
    const html = await item.getType('text/html').then(blob => blob.text()).catch(() => undefined);
    const visibleText = html === undefined ? undefined : copiedFragmentText(document, html);
    if (visibleText !== undefined) return visibleText;
  }
  return plain ? (await plain.getType('text/plain')).text() : '';
}

/** Insert a copied fragment's visible text in plain mode, or use the browser's regular paste formats. */
export async function pasteFromMarkdownClipboard(view: EditorView, isCurrent: () => boolean, plain = false): Promise<void> {
  const document = view.dom.ownerDocument;
  const clipboard = document.defaultView?.navigator.clipboard;
  if (!clipboard) throw new Error('Clipboard access is unavailable');
  if (plain) {
    const text = await readPlainClipboardText(clipboard, document);
    if (text && isCurrent()) view.pasteText(text);
    return;
  }
  const data = new DataTransfer();
  if (clipboard.read) {
    const formats = ['text/html', 'text/plain', 'text/uri-list'];
    const items = await clipboard.read();
    const item = items.find(item => formats.some(type => item.types.includes(type)));
    if (!item) return;
    await Promise.all(formats.filter(type => item.types.includes(type)).map(async type => {
      data.setData(type, await (await item.getType(type)).text());
    }));
  } else {
    data.setData('text/plain', await clipboard.readText());
  }
  if (isCurrent() && data.types.some(type => data.getData(type))) {
    // Shift may have been released in the menu after Shift+F10. This paste uses the regular rich mode.
    view.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', keyCode: 16 }));
    view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }
}

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
    const document = view.dom.ownerDocument;
    const template = document.createElement('template');
    template.innerHTML = html;
    const underlined = new Set<Element>();
    for (const element of template.content.querySelectorAll('*')) {
      if (element.namespaceURI !== htmlNamespace || element.matches(discarded)) {
        element.remove();
        continue;
      }
      const { style } = element as HTMLElement;
      const alignment = style.textAlign;
      const emphasis = emphasisStyles.map(name => [name, style.getPropertyValue(name)] as const).filter(([, value]) => value);
      // Google Docs also puts this style on link labels. Keep their ordinary link formatting.
      const decoration = style.textDecorationLine || style.textDecoration;
      if (decoration?.split(/\s+/).includes('underline')) underlined.add(element);
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
    if (underlined.size) applyPastedUnderline(document, template.content, underlined);
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
