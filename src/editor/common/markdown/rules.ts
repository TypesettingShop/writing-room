import type Ruler from 'markdown-it/lib/ruler.mjs';

/** Replace a named rule without importing markdown-it's private rule modules. */
export function wrapMarkdownRule<Rule>(
  ruler: Ruler<Rule>,
  name: string,
  wrap: (original: Rule) => Rule,
  alt: string[] = [],
): void {
  const rules = ruler.getRules('');
  ruler.disable([name]);
  const remaining = ruler.getRules('');
  if (rules.length === remaining.length) return;
  const removed = rules.findIndex((rule, index) => rule !== remaining[index]);
  const original = rules[removed];
  ruler.at(name, wrap(original), { alt });
  ruler.enable([name]);
}
