import type Token from 'markdown-it/lib/token.mjs';
import type { Node } from 'prosemirror-model';
import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createMarkdownIt } from '../../../../editor/common/markdown/markdownIt.js';

export interface MarkdownFootnote {
  readonly label: string | null;
  readonly text: string;
  readonly definitionPos?: number;
  readonly referencePos?: number;
  readonly status?: 'missing' | 'unused';
}

const inlineMarkdown = createMarkdownIt();
const plainTexts = new WeakMap<Node, string>();

function inlineText(tokens: readonly Token[]): string {
  return tokens.map(token => {
    if (token.children) return inlineText(token.children);
    if (token.type === 'hardbreak' || token.type === 'softbreak') return ' ';
    return token.type === 'text' || token.type === 'code_inline' ? token.content : '';
  }).join('');
}

function footnoteText(node: Node): string {
  const previous = plainTexts.get(node);
  if (previous !== undefined) return previous;
  const text = node.type.name === 'footnote_reference'
    ? inlineText(inlineMarkdown.parseInline(node.attrs.source ?? '', {}))
    : node.textBetween(0, node.content.size, ' ', child => {
      return child.type.name === 'hard_break' || child.type.name === 'soft_break' ? ' ' : '';
    }).replace(/\r\n|[\r\n]/g, ' ');
  plainTexts.set(node, text);
  return text;
}

export function collectFootnotes(doc: Node): readonly MarkdownFootnote[] {
  const definitions = new Map<string, { node: Node; pos: number }>();
  const references: { node: Node; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'footnote_definition' && !definitions.has(node.attrs.label)) {
      definitions.set(node.attrs.label, { node, pos });
    } else if (node.type.name === 'footnote_reference') {
      references.push({ node, pos });
    }
  });

  const notes: MarkdownFootnote[] = [];
  const seen = new Set<string>();
  for (const { node, pos } of references) {
    const label: string | null = node.attrs.label;
    if (label === null) {
      notes.push({ label, text: footnoteText(node), referencePos: pos });
    } else if (!seen.has(label)) {
      seen.add(label);
      const definition = definitions.get(label);
      notes.push(definition
        ? { label, text: footnoteText(definition.node), definitionPos: definition.pos, referencePos: pos }
        : { label, text: '', referencePos: pos, status: 'missing' });
    }
  }
  for (const [label, { node, pos }] of definitions) {
    if (!seen.has(label)) notes.push({ label, text: footnoteText(node), definitionPos: pos, status: 'unused' });
  }
  return notes;
}

export class MarkdownFootnotesPanel extends Disposable {
  private readonly element: HTMLElement;
  private readonly list: HTMLOListElement;
  private readonly refresh = this._register(new RunOnceScheduler(() => this.render(), 200));
  private enabled = false;
  private doc: Node | undefined;
  private renderedDoc: Node | undefined;
  private entries: readonly MarkdownFootnote[] = [];

  constructor(
    parent: HTMLElement,
    hide: () => void,
    reveal: (doc: Node, note: MarkdownFootnote) => void,
  ) {
    super();
    this.element = append(parent, $('.markdown-footnotes', { role: 'region', 'aria-label': 'Footnotes', hidden: '' }));
    const header = append(this.element, $('.markdown-footnotes-header'));
    append(header, $('span', undefined, 'Footnotes'));
    const hideButton = append(header, $('button.codicon.codicon-chevron-down', {
      type: 'button', title: 'Hide Footnotes Panel', 'aria-label': 'Hide Footnotes Panel',
    }));
    this.list = append(this.element, $('ol')) as HTMLOListElement;
    // A mouse click can activate a button without first changing the writing selection.
    this._register(addDisposableListener(this.element, 'mousedown', event => {
      if (event.button === 0 && (event.target as Element).closest('button')) event.preventDefault();
    }));
    this._register(addDisposableListener(hideButton, 'click', hide));
    this._register(addDisposableListener(this.list, 'click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button[data-footnote-index]');
      const entry = button && this.entries[Number(button.dataset.footnoteIndex)];
      if (this.renderedDoc && entry) reveal(this.renderedDoc, entry);
    }));
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.refresh.cancel();
    this.render();
  }

  setDocument(doc: Node | undefined, immediate = false): void {
    if (doc === this.doc) return;
    this.doc = doc;
    if (!this.enabled) return;
    if (immediate) {
      this.refresh.cancel();
      this.render();
    } else {
      this.refresh.schedule();
    }
  }

  private render(): void {
    const doc = this.enabled ? this.doc : undefined;
    if (doc === this.renderedDoc) return;
    this.renderedDoc = doc;
    const entries = doc ? collectFootnotes(doc) : [];
    const sameRows = entries.length === this.entries.length && entries.every((note, index) => {
      const previous = this.entries[index];
      return note.label === previous.label && note.text === previous.text && note.status === previous.status;
    });
    this.entries = entries;
    if (sameRows) return;

    this.element.hidden = entries.length === 0;
    this.list.replaceChildren();
    for (const [index, note] of this.entries.entries()) {
      const item = append(this.list, $('li'));
      const button = append(item, $('button', { type: 'button', 'data-footnote-index': String(index) }));
      if (note.label !== null) append(button, $('span.markdown-footnote-label', undefined, `[${note.label}]`));
      append(button, $('span', undefined, note.text || (note.status === 'missing' ? 'Missing definition' : 'Empty footnote')));
      if (note.status === 'unused') append(button, $('span.markdown-footnote-status', undefined, 'Unused'));
    }
  }
}
