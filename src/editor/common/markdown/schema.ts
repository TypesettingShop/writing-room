import { Schema } from 'prosemirror-model';
import type { Attrs, MarkSpec, Node, NodeSpec, TagParseRule } from 'prosemirror-model';
import { schema as basicMarkdownSchema } from 'prosemirror-markdown';
import { isMarkdownClass, markdownUnderlineClass } from './plugins/attrs.js';

const classes = { default: [], validate: 'object' } as const;
const markup = { default: null, validate: 'string|null' } as const;

function classAttribute(attrs: Attrs): Record<string, string> {
  return attrs.classes.length ? { class: attrs.classes.join(' ') } : {};
}

function readClasses(element: HTMLElement): string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter(isMarkdownClass);
}

// Inline elements a span can sit in. The first other ancestor ends the walk below.
const inlineElements = 'a, abbr, b, cite, code, del, em, font, i, ins, kbd, mark, q, s, small, span, strike, strong, sub, sup, u';

/**
 * The span mark excludes itself, so a `u` or classed `span` inside another one replaces it.
 * The inner mark carries the outer class lists so `<span class="size-lg"><u>` keeps both.
 */
function spanClasses(element: HTMLElement, own: readonly string[]): string[] {
  const outer: string[] = [];
  for (let parent = element.parentElement; parent?.matches(inlineElements); parent = parent.parentElement) {
    if (parent.localName === 'u') outer.unshift(...readClasses(parent), markdownUnderlineClass);
    else if (parent.localName === 'span') outer.unshift(...readClasses(parent));
  }
  return outer.length ? [...new Set([...outer, ...own])] : [...own];
}

function styledBlock(tag: string, spec: NodeSpec = {}): NodeSpec {
  return {
    group: 'block',
    ...spec,
    attrs: { classes, ...spec.attrs },
    parseDOM: [{ tag, getAttrs: element => ({ classes: readClasses(element) }) }],
    toDOM: node => [tag, classAttribute(node.attrs), 0],
  };
}

function tableCell(tag: 'td' | 'th', tableRole: 'cell' | 'header_cell'): NodeSpec {
  return {
    ...styledBlock(tag, {
      content: 'inline*', group: '', isolating: true, tableRole,
      attrs: {
        align: { default: null, validate: 'string|null' },
        // TableMap needs span and width attributes. GFM cells always occupy one slot.
        colspan: { default: 1, validate: 'number' },
        rowspan: { default: 1, validate: 'number' },
        colwidth: { default: null, validate: 'null' },
      },
    }),
    parseDOM: [{
      tag,
      getAttrs: element => ({
        align: /^(left|center|right)$/.test(element.style.textAlign) ? element.style.textAlign : null,
        classes: readClasses(element),
      }),
    }],
    toDOM: node => [tag, {
      ...classAttribute(node.attrs), ...(node.attrs.align && { style: `text-align: ${node.attrs.align}` }),
    }, 0],
  };
}

export function isMarkdownTableCell(node: Node): boolean {
  const role = node.type.spec.tableRole;
  return role === 'cell' || role === 'header_cell';
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  paragraph: styledBlock('p', { content: 'inline*' }),
  blockquote: styledBlock('blockquote', { content: 'block+', defining: true }),
  heading: {
    ...styledBlock('h1', { content: 'inline*', defining: true, attrs: { level: { default: 1, validate: 'number' } } }),
    parseDOM: Array.from({ length: 6 }, (_, index): TagParseRule => ({
      tag: `h${index + 1}`,
      getAttrs: element => ({ level: index + 1, classes: readClasses(element) }),
    })),
    toDOM: node => [`h${node.attrs.level}`, classAttribute(node.attrs), 0],
  },
  code_block: {
    ...styledBlock('pre', {
      content: 'text*', marks: '', code: true, defining: true,
      attrs: { info: { default: '', validate: 'string' }, markup },
    }),
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full', getAttrs: element => ({
      classes: readClasses(element), info: element.getAttribute('data-code-info') ?? '',
    }) }],
    toDOM: node => ['pre', { ...classAttribute(node.attrs), 'data-code-info': node.attrs.info }, ['code', 0]],
  },
  horizontal_rule: {
    ...styledBlock('hr', { attrs: { markup } }),
    toDOM: node => ['hr', classAttribute(node.attrs)],
  },
  bullet_list: styledBlock('ul', {
    content: '(list_item | task_item)+',
    attrs: { tight: { default: true, validate: 'boolean' }, bullet: { default: '-', validate: 'string' } },
  }),
  ordered_list: {
    ...styledBlock('ol', {
      content: '(list_item | task_item)+',
      attrs: { tight: { default: true, validate: 'boolean' }, order: { default: 1, validate: 'number' }, markup },
    }),
    parseDOM: [{ tag: 'ol', getAttrs: element => ({
      order: Number(element.getAttribute('start') ?? 1), classes: readClasses(element),
    }) }],
    toDOM: node => ['ol', { ...classAttribute(node.attrs), start: node.attrs.order }, 0],
  },
  list_item: {
    ...styledBlock('li', { content: 'paragraph block*', group: '', defining: true }),
    parseDOM: [{ tag: 'li:not([data-task-checked])', getAttrs: element => ({ classes: readClasses(element) }) }],
  },
  task_item: {
    ...styledBlock('li', {
      content: 'paragraph block*', group: '', defining: true,
      attrs: { checked: { default: false, validate: 'boolean' } },
    }),
    parseDOM: [{ tag: 'li[data-task-checked]', getAttrs: element => ({
      checked: element.getAttribute('data-task-checked') === 'true', classes: readClasses(element),
    }) }],
    toDOM: node => ['li', { ...classAttribute(node.attrs), 'data-task-checked': String(node.attrs.checked) }, 0],
  },
  table: {
    ...styledBlock('table', { content: 'table_row+', isolating: true, tableRole: 'table' }),
    toDOM: node => ['table', classAttribute(node.attrs), ['tbody', 0]],
  },
  table_row: styledBlock('tr', { content: '(table_cell | table_header)+', group: '', tableRole: 'row' }),
  table_cell: tableCell('td', 'cell'),
  table_header: tableCell('th', 'header_cell'),
  image: basicMarkdownSchema.spec.nodes.get('image')!,
  hard_break: basicMarkdownSchema.spec.nodes.get('hard_break')!,
  // Keep soft line breaks as inline whitespace so editing does not concatenate source lines.
  soft_break: {
    inline: true, group: 'inline', selectable: false, linebreakReplacement: true,
    toDOM: () => ['span', ' '], leafText: () => '\n',
  },
  footnote_definition: {
    ...styledBlock('div[data-footnote]', { content: 'block+', defining: true, attrs: { label: { validate: 'string' } } }),
    parseDOM: [{ tag: 'div[data-footnote]', getAttrs: element => ({
      label: element.getAttribute('data-footnote'), classes: readClasses(element),
    }) }],
    toDOM: node => ['div', { ...classAttribute(node.attrs), 'data-footnote': node.attrs.label }, 0],
  },
  footnote_reference: {
    inline: true, group: 'inline', atom: true,
    attrs: { label: { default: null, validate: 'string|null' }, source: { default: null, validate: 'string|null' } },
    toDOM: node => ['sup', node.attrs.label ? `[${node.attrs.label}]` : '[*]'],
  },
  raw_block: {
    group: 'block', atom: true,
    attrs: { classes, source: { validate: 'string' } },
    toDOM: node => ['pre', classAttribute(node.attrs), node.attrs.source],
  },
  text: { group: 'inline' },
};

const marks: Record<string, MarkSpec> = {
  // Keep link outside span so the span can appear inside a link label.
  link: basicMarkdownSchema.spec.marks.get('link')!,
  span: {
    attrs: { classes },
    parseDOM: [
      { tag: 'span[class]', getAttrs: element => {
        const classes = readClasses(element);
        return classes.length ? { classes: spanClasses(element, classes) } : false;
      } },
      { tag: 'u', getAttrs: element => ({
        classes: spanClasses(element, [...new Set([...readClasses(element), markdownUnderlineClass])]),
      }) },
    ],
    toDOM: mark => [mark.attrs.classes.includes(markdownUnderlineClass) ? 'u' : 'span', classAttribute(mark.attrs), 0],
  },
  em: { ...basicMarkdownSchema.spec.marks.get('em'), attrs: { markup } },
  strong: { ...basicMarkdownSchema.spec.marks.get('strong'), attrs: { markup } },
  strike: { attrs: { markup }, parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] },
  code: { ...basicMarkdownSchema.spec.marks.get('code'), attrs: { markup } },
};

export const markdownSchema = new Schema({ nodes, marks });
