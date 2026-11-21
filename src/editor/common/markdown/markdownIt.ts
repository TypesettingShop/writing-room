import MarkdownIt from 'markdown-it';
import { footnote } from '@mdit/plugin-footnote';
import { tasklist } from '@mdit/plugin-tasklist';
import type Token from 'markdown-it/lib/token.mjs';
import { markdownAttrs } from './plugins/attrs.js';
import { wrapMarkdownRule } from './rules.js';

export interface IMarkdownItPluginContribution<Options = unknown> {
  readonly id: string;
  readonly plugin: (markdownIt: MarkdownIt, options: Options) => void;
  readonly options?: Options;
}

export interface IMarkdownItOptions {
  // Options are heterogeneous across plugins. Each contribution pairs its plugin with its options.
  readonly plugins?: readonly IMarkdownItPluginContribution<any>[];
}

function keepTaskMarkerLiteral(markdownIt: MarkdownIt): void {
  wrapMarkdownRule(markdownIt.core.ruler, 'inline', parseInline => state => {
    const tasks: { token: Token; marker: string; source: string }[] = [];
    state.tokens.forEach((token, index) => {
      if (token.type !== 'inline' || state.tokens[index - 1]?.type !== 'paragraph_open' ||
        state.tokens[index - 2]?.type !== 'list_item_open') return;
      const match = /^(\[[ xX]\])(?:[ \t\u00a0]|$)/.exec(token.content);
      if (!match) return;
      const source = token.content.slice(match[0].length);
      tasks.push({ token, marker: match[1] + ' ', source });
      // A checkbox marker is structural even if the same label defines a shortcut link.
      token.content = source;
    });
    parseInline(state);
    for (const { token, marker, source } of tasks) {
      token.content = marker + source;
      const children = token.children!;
      if (children[0]?.type === 'text') {
        children[0].content = marker + children[0].content;
      } else {
        const prefix = new state.Token('text', '', 0);
        prefix.content = marker;
        children.unshift(prefix);
      }
    }
  });
}

const defaultPlugins: NonNullable<IMarkdownItOptions['plugins']> = [
  { id: 'footnote', plugin: footnote },
  { id: 'tasklist', plugin: (md, options) => {
    tasklist(md, options);
    keepTaskMarkerLiteral(md);
  }, options: { label: false } },
  { id: 'classes', plugin: markdownAttrs },
];

export function createMarkdownIt(options: IMarkdownItOptions = {}): MarkdownIt {
  const markdownIt = new MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough']);
  const registered = new Set<string>();
  for (const { id, plugin, options: pluginOptions } of [...defaultPlugins, ...(options.plugins ?? [])]) {
    if (registered.has(id)) {
      throw new Error(`Duplicate markdown-it plugin: ${id}`);
    }
    markdownIt.use(plugin, pluginOptions);
    registered.add(id);
  }
  return markdownIt;
}
