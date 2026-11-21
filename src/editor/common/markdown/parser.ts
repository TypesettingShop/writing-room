import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type { Node } from 'prosemirror-model';
import { MarkdownParser } from 'prosemirror-markdown';
import type { ParseSpec } from 'prosemirror-markdown';
import { createMarkdownIt } from './markdownIt.js';
import type { IMarkdownItOptions } from './markdownIt.js';
import { getMarkdownClasses } from './plugins/attrs.js';
import { markdownSchema } from './schema.js';

export interface IMarkdownSourceBlock {
  readonly from: number;
  readonly to: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface IParsedMarkdown {
  readonly doc: Node;
  readonly blocks: readonly IMarkdownSourceBlock[];
}

type LineRange = [start: number, end: number];

interface IParseEnvironment {
  ranges: (LineRange | null)[];
  footnotes?: { list?: { content?: string }[] };
}

const nodesWithClasses: Record<string, string> = {
  paragraph: 'paragraph',
  blockquote: 'blockquote',
  list_item: 'list_item',
  table: 'table',
  tr: 'table_row',
};

function blockAttrs(token: Token) {
  return { classes: getMarkdownClasses(token) };
}

function listAttrs(token: Token, tokens: Token[], index: number) {
  const content = tokens[index + 2];
  return { ...blockAttrs(token), tight: content?.type === 'paragraph_open' && content.hidden };
}

function cellAttrs(token: Token, header: boolean) {
  return { ...blockAttrs(token), header, align: token.attrGet('style')?.match(/^text-align:(left|center|right)$/)?.[1] ?? null };
}

function imageAlt(tokens: readonly Token[]): string {
  return tokens.map(token => token.type === 'image'
    ? imageAlt(token.children ?? [])
    : token.type === 'softbreak' || token.type === 'hardbreak'
      ? '\n'
      : ['text', 'code_inline', 'text_special'].includes(token.type) ? token.content : '').join('');
}

const tokenSpecs: Record<string, ParseSpec> = {
  ...Object.fromEntries(Object.entries(nodesWithClasses)
    .map(([token, block]) => [token, { block, getAttrs: blockAttrs }])),
  heading: { block: 'heading', getAttrs: token => ({ ...blockAttrs(token), level: Number(token.tag[1]) }) },
  fence: { block: 'code_block', getAttrs: token => ({ ...blockAttrs(token), info: token.info.trim(), markup: token.markup }) },
  code_block: { block: 'code_block', getAttrs: blockAttrs },
  hr: { node: 'horizontal_rule', getAttrs: token => ({ ...blockAttrs(token), markup: token.markup }) },
  bullet_list: { block: 'bullet_list', getAttrs: (token, tokens, index) => ({
    ...listAttrs(token, tokens, index), bullet: token.markup,
  }) },
  ordered_list: { block: 'ordered_list', getAttrs: (token, tokens, index) => ({
    ...listAttrs(token, tokens, index), order: Number(token.attrGet('start') ?? 1), markup: token.markup,
  }) },
  task_item: { block: 'task_item', getAttrs: token => ({ ...blockAttrs(token), checked: token.meta.checked }) },
  thead: { ignore: true },
  tbody: { ignore: true },
  th: { block: 'table_cell', getAttrs: token => cellAttrs(token, true) },
  td: { block: 'table_cell', getAttrs: token => cellAttrs(token, false) },
  image: { node: 'image', getAttrs: token => ({
    src: token.attrGet('src'), title: token.attrGet('title'), alt: imageAlt(token.children ?? []),
  }) },
  hardbreak: { node: 'hard_break' },
  softbreak: { node: 'soft_break' },
  footnote_reference: { block: 'footnote_definition', getAttrs: token => ({ ...blockAttrs(token), label: token.meta.label }) },
  footnote_ref: { node: 'footnote_reference', getAttrs: token => ({ label: token.meta.label, source: token.meta.source }) },
  raw_source: { node: 'raw_block', getAttrs: token => ({ ...blockAttrs(token), source: token.content }) },
  em: { mark: 'em', getAttrs: token => ({ markup: token.markup }) },
  strong: { mark: 'strong', getAttrs: token => ({ markup: token.markup }) },
  s: { mark: 'strike', getAttrs: token => ({ markup: token.markup }) },
  code_inline: { mark: 'code', getAttrs: token => ({ markup: token.markup }) },
  link: { mark: 'link', getAttrs: token => ({ href: token.attrGet('href'), title: token.attrGet('title') }) },
  class_span: { mark: 'span', getAttrs: blockAttrs },
};

function adaptBlockRules(markdownIt: MarkdownIt): void {
  const ruler = markdownIt.block.ruler;
  // Use markdown-it's registered rules so reference validation and footnote parsing stay in the tokenizer.
  for (const name of ['reference', 'footnoteDef']) {
    const rules = ruler.getRules('');
    if (!ruler.disable([name], true).length) continue;
    const remaining = ruler.getRules('');
    const original = rules.find(rule => !remaining.includes(rule))!;
    ruler.at(name, (state, start, end, silent) => {
      const tokenIndex = state.tokens.length;
      if (!original(state, start, end, silent)) return false;
      if (!silent && name === 'footnoteDef') {
        state.tokens[tokenIndex].map = [start, state.line];
      } else if (!silent) {
        const token = state.push('raw_source', '', 0);
        token.map = [start, state.line];
        token.content = state.getLines(start, state.line, state.blkIndent, false);
      }
      return true;
    }, { alt: name === 'footnoteDef' ? ['paragraph', 'reference'] : [] });
    ruler.enable([name]);
  }
  // Keep definitions in place, including definitions that have no references.
  markdownIt.disable('footnoteTail');
}

function adaptTaskItems(tokens: Token[]): void {
  const items: Token[] = [];
  tokens.forEach((token, index) => {
    if (token.type === 'list_item_open') {
      items.push(token);
    } else if (token.type === 'list_item_close') {
      if (items.pop()?.type === 'task_item_open') token.type = 'task_item_close';
    } else if (token.type === 'inline' && token.children?.[0]?.type === 'checkbox_input') {
      const item = tokens[index - 2];
      const checkbox = token.children.shift()!;
      item.type = 'task_item_open';
      item.meta = { ...item.meta, checked: checkbox.attrGet('checked') !== null };
      const first = token.children[0];
      if (first?.type === 'text') first.content = first.content.replace(/^[ \u00a0]/, '');
    }
  });
}

function prepareInline(token: Token, env: IParseEnvironment): void {
  if (token.type === 'footnote_ref' && token.meta.label == null) {
    token.meta.source = env.footnotes?.list?.[token.meta.id]?.content ?? '';
  }
  token.children?.forEach(child => prepareInline(child, env));
}

function isSupported(token: Token, supported: ReadonlySet<string>): boolean {
  return supported.has(token.type) && (token.type !== 'inline' ||
    (token.children ?? []).every(child => isSupported(child, supported)));
}

function groupTopLevel(tokens: Token[]): Token[][] {
  const groups: Token[][] = [];
  let start = 0;
  let depth = 0;
  tokens.forEach((token, index) => {
    depth += token.nesting;
    if (depth === 0) {
      groups.push(tokens.slice(start, index + 1));
      start = index + 1;
    }
  });
  if (start < tokens.length) groups.push(tokens.slice(start));
  return groups;
}

function supportedTokenTypes(): Set<string> {
  const types = new Set(['inline', 'text', 'softbreak']);
  for (const [name, spec] of Object.entries(tokenSpecs)) {
    if (spec.node || spec.noCloseToken || ['code_inline', 'code_block', 'fence'].includes(name)) {
      types.add(name);
    } else {
      types.add(`${name}_open`);
      types.add(`${name}_close`);
    }
  }
  return types;
}

function sourceLineStarts(source: string): number[] {
  return [0, ...Array.from(source.matchAll(/\r\n|\r|\n/g), match => match.index + match[0].length)];
}

interface IOriginalMarkdown {
  readonly source: string;
  readonly parsed: IParsedMarkdown;
}

const originalMarkdown = new WeakMap<Node['attrs'], IOriginalMarkdown>();

export function getOriginalMarkdown(doc: Node): IOriginalMarkdown | undefined {
  return originalMarkdown.get(doc.attrs);
}

export function createMarkdownParser(options?: IMarkdownItOptions): (source: string) => IParsedMarkdown {
  const markdownIt = createMarkdownIt(options);
  adaptBlockRules(markdownIt);
  const supported = supportedTokenTypes();
  markdownIt.core.ruler.push('prosemirror_source', state => {
    const env = state.env as IParseEnvironment;
    adaptTaskItems(state.tokens);
    state.tokens.forEach(token => prepareInline(token, env));
    const lines = state.src.split('\n');
    state.tokens = groupTopLevel(state.tokens).flatMap(group => {
      const first = group[0];
      const range = first.map;
      env.ranges.push(range);
      if (group.every(token => isSupported(token, supported))) return group;
      const raw = new state.Token('raw_source', '', 0);
      // A nested unknown token can depend on its surrounding syntax. Keep the entire outer block.
      raw.content = range ? lines.slice(...range).join('\n') : group.map(token => token.content).join('');
      if (!range && !raw.content) {
        throw new Error(`Cannot preserve markdown-it token "${first.type}" without a source range or content`);
      }
      return [raw];
    });
  });
  const parser = new MarkdownParser(markdownSchema, markdownIt, tokenSpecs);

  return source => {
    const env: IParseEnvironment = { ranges: [] };
    const parsed = parser.parse(source, env);
    // ProseMirror transactions copy the document with these same attrs. Keep source
    // provenance off the public schema and out of ProseMirror JSON.
    const doc = parsed.type.create({}, parsed.content);
    const lines = sourceLineStarts(source);
    const blocks: IMarkdownSourceBlock[] = [];
    if (env.ranges.length !== 0 && env.ranges.length !== doc.childCount) {
      throw new Error('Markdown token groups and document blocks do not match');
    }
    doc.forEach((node, offset, index) => {
      const range = env.ranges[index];
      if (!range) return;
      const [startLine, endLine] = range;
      const startOffset = lines[startLine] ?? source.length;
      const endOffset = lines[endLine] ?? source.length;
      blocks.push({ from: offset, to: offset + node.nodeSize, startLine, endLine, startOffset, endOffset });
    });
    const result = { doc, blocks };
    originalMarkdown.set(doc.attrs, { source, parsed: result });
    return result;
  };
}

export const parseMarkdownWithSource = createMarkdownParser();

export function parseMarkdown(source: string): Node {
  return parseMarkdownWithSource(source).doc;
}
