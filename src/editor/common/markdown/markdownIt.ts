import MarkdownIt from 'markdown-it';
import { footnote } from '@mdit/plugin-footnote';
import { tasklist } from '@mdit/plugin-tasklist';

export interface IMarkdownItPluginContribution<Options = unknown> {
  readonly id: string;
  readonly plugin: (markdownIt: MarkdownIt, options: Options) => void;
  readonly options?: Options;
}

export interface IMarkdownItOptions {
  // Options are heterogeneous across plugins. Each contribution pairs its plugin with its options.
  readonly plugins?: readonly IMarkdownItPluginContribution<any>[];
}

const defaultPlugins: NonNullable<IMarkdownItOptions['plugins']> = [
  { id: 'footnote', plugin: footnote },
  { id: 'tasklist', plugin: tasklist, options: { label: false } },
];

export function createMarkdownIt(options: IMarkdownItOptions = {}): MarkdownIt {
  const markdownIt = new MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough']);
  const registered = new Set<string>();
  for (const { id, plugin, options: pluginOptions } of [...defaultPlugins, ...options.plugins ?? []]) {
    if (registered.has(id)) {
      throw new Error(`Duplicate markdown-it plugin: ${id}`);
    }
    markdownIt.use(plugin, pluginOptions);
    registered.add(id);
  }
  return markdownIt;
}
