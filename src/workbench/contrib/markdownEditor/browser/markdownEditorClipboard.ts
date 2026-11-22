import { DOMParser, Fragment, Slice } from 'prosemirror-model';
import type { Mark, Node as ProseMirrorNode, ResolvedPos } from 'prosemirror-model';
import type { Selection } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import type { EditorProps, EditorView } from 'prosemirror-view';
import { createMarkdownIt } from '../../../../editor/common/markdown/markdownIt.js';
import { parseMarkdown } from '../../../../editor/common/markdown/parser.js';
import { markdownSchema } from '../../../../editor/common/markdown/schema.js';
import { serializeMarkdown } from '../../../../editor/common/markdown/serializer.js';
import { readTabStorage, writeTabStorage } from '../../../services/storage/browser/storageService.js';
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
const clipboardRenderer = createMarkdownIt();

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

/** The text a copied fragment shows, with line breaks between blocks and alt text for images. */
function visibleText(content: Fragment): string {
  const { hard_break, soft_break, image } = markdownSchema.nodes;
  return content.textBetween(0, content.size, '\n', node => {
    if (node.type === image) return node.attrs.alt ?? '';
    if (node.type === hard_break) return '\n';
    return node.type === soft_break ? ' ' : '';
  });
}

// The native Ctrl/Cmd+Shift+V paste event carries only text/plain, which holds the Markdown this editor wrote on copy.
// The last copy's Markdown and visible text are kept, also in this browser tab's session storage so they outlive a
// reload, and a plain paste of exactly that Markdown inserts the visible text. Other text/plain stays literal.
const lastCopyKey = 'writing-room:markdownEditor:lastCopy';
const lastCopyLimit = 1 << 20;
let lastCopy: { readonly markdown: string; readonly text: string } | undefined;
const lineBreaks = (text: string) => text.replace(/\r\n?/g, '\n');

function rememberCopy(browserWindow: Window | null, markdown: string, content: Fragment): void {
  lastCopy = { markdown: lineBreaks(markdown), text: visibleText(content) };
  if (lastCopy.markdown.length + lastCopy.text.length <= lastCopyLimit) {
    const serialized = JSON.stringify(lastCopy);
    if (new TextEncoder().encode(serialized).byteLength <= lastCopyLimit) {
      writeTabStorage(browserWindow, lastCopyKey, serialized);
      return;
    }
  }
  writeTabStorage(browserWindow, lastCopyKey, undefined);
}

/** An ordered list cut after its first items keeps the numbers its remaining items show. */
function withListStarts(slice: Slice, $from: ResolvedPos): Slice {
  const { ordered_list } = markdownSchema.nodes;
  const edge = (fragment: Fragment, depth: number): Fragment => {
    const first = fragment.firstChild;
    if (!first || depth > Math.min(slice.openStart, $from.depth)) return fragment;
    const source = $from.node(depth);
    const attrs = first.type === ordered_list && source.type === ordered_list
      ? { ...first.attrs, order: source.attrs.order + $from.index(depth) } : first.attrs;
    return fragment.replaceChild(0, first.type.create(attrs, edge(first.content, depth + 1), first.marks));
  };
  return new Slice(edge(slice.content, 1), slice.openStart, slice.openEnd);
}

/** The selection with the blocks around it, which Copy as HTML renders. */
function enclosedSlice(selection: Selection): Slice {
  if (selection instanceof CellSelection) {
    const slice = selection.content();
    // A cell range smaller than the table keeps its table, as the regular copy's HTML does.
    return slice.content.firstChild?.type === markdownSchema.nodes.table_row
      ? new Slice(Fragment.from(selection.$anchorCell.node(-1).copy(slice.content)), 1, 1) : slice;
  }
  // A selected list item stays in its list. Text selections already include their parents.
  const { $from, from, to } = selection;
  return withListStarts($from.doc.slice(from, to, true), $from);
}

export async function copyMarkdownFragment(browserWindow: Window, selection: Selection, format: 'markdown' | 'html'): Promise<void> {
  const clipboard = browserWindow.navigator.clipboard;
  if (!clipboard) throw new Error('Clipboard access is unavailable');
  const slice = format === 'html' ? enclosedSlice(selection) : selection.content();
  const markdown = serializeClipboardMarkdown(slice, format === 'html');
  if (format === 'markdown') {
    await clipboard.writeText(markdown);
    rememberCopy(browserWindow, markdown, slice.content);
  } else {
    const html = clipboardRenderer.render(markdown);
    const { ClipboardItem } = browserWindow as Window & typeof globalThis;
    await clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([html], { type: 'text/plain' }),
    })]);
  }
}

function copiedPlainText(view: EditorView, text: string): string {
  if (!lastCopy) {
    try {
      const stored: unknown = JSON.parse(readTabStorage(view.dom.ownerDocument.defaultView, lastCopyKey) ?? 'null');
      if (stored && typeof stored === 'object' && 'markdown' in stored && 'text' in stored
        && typeof stored.markdown === 'string' && typeof stored.text === 'string') {
        lastCopy = { markdown: stored.markdown, text: stored.text };
      }
    } catch {
      // An unreadable entry is treated as no copy.
    }
  }
  return lastCopy && lineBreaks(text) === lastCopy.markdown ? lastCopy.text : text;
}

function copiedFragmentText(document: Document, html: string): string | undefined {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll(discarded)) element.remove();
  // ProseMirror marks the first element of the serialized fragment, including any table wrapper.
  if (!template.content.firstElementChild?.hasAttribute('data-pm-slice')) return undefined;
  // As in ProseMirror's own clipboard parse, a block parent drops whitespace between blocks, such as the line
  // breaks around a Windows CF_HTML fragment. The container belongs to the inert template document.
  const root = template.content.ownerDocument.createElement('div');
  root.append(template.content);
  return visibleText(DOMParser.fromSchema(markdownSchema).parseSlice(root, { preserveWhitespace: true }).content);
}

async function readPlainClipboardText(clipboard: Clipboard, document: Document): Promise<string> {
  // Keep literal text paste available when the richer clipboard read is unavailable. A rejected read (a denied or
  // dismissed permission request) is not retried with readText, which would ask the person a second time.
  if (!clipboard.read) return clipboard.readText();
  const items = await clipboard.read();
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

  clipboardTextParser(text, $context, plain, view) {
    if (plain) {
      const { paragraph } = markdownSchema.nodes;
      const blocks = copiedPlainText(view, text).split(/\r\n?|\n/).map(line => paragraph.create(
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

  clipboardTextSerializer(slice, view) {
    const markdown = serializeClipboardMarkdown(slice);
    rememberCopy(view.dom.ownerDocument.defaultView, markdown, slice.content);
    return markdown;
  },
};

function serializeClipboardMarkdown(slice: Slice, preserveBlocks = false): string {
  let { content, openStart, openEnd } = slice;
  // A cell selection over the whole table copies the table, opened only at its rows.
  if (content.childCount === 1 && content.firstChild!.type === markdownSchema.nodes.table && openStart === 1 && openEnd === 1) {
    return serializeMarkdown(markdownSchema.topNodeType.create(null, content));
  }
  // Markdown text from one block omits surrounding markers. HTML renders the enclosing blocks and their classes.
  if (!preserveBlocks) {
    while (content.childCount === 1 && openStart > 0 && openEnd > 0 && !content.firstChild!.isTextblock) {
      content = content.firstChild!.content;
      openStart--;
      openEnd--;
    }
    if (content.childCount === 1 && openStart > 0 && openEnd > 0 && content.firstChild!.isTextblock) {
      if (content.firstChild!.type.spec.code) return content.firstChild!.textContent;
      content = content.firstChild!.content;
    }
  }
  content = content.firstChild?.isInline
    ? Fragment.from(markdownSchema.nodes.paragraph.create(null, content)) : content;
  return markdownSchema.topNodeType.validContent(content)
    ? serializeMarkdown(markdownSchema.topNodeType.create(null, content))
    : content.textBetween(0, content.size, '\n\n');
}
