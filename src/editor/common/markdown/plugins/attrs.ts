import type { PluginSimple } from 'markdown-it';
import type { RuleCore } from 'markdown-it/lib/parser_core.mjs';
import type { RuleInline } from 'markdown-it/lib/parser_inline.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import { wrapMarkdownRule } from '../rules.js';

const classList = /\{(\.[a-z][a-z0-9-]*(?:[ \t]+\.[a-z][a-z0-9-]*)*)\}/;
const classAtStart = new RegExp(`^${classList.source}`);

export function isMarkdownClass(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

export function getMarkdownClasses(token: Token): string[] {
  return token.meta?.markdownClasses ?? [];
}

function addClasses(token: Token, list: string): void {
  const classes = list.split(/[ \t]+/).map(name => name.slice(1));
  token.meta = { ...token.meta, markdownClasses: [...getMarkdownClasses(token), ...classes] };
  token.attrJoin('class', classes.join(' '));
}

const insideSpan = new WeakSet<StateInline>();
const imageLabelEnvironments = new WeakSet<object>();

function isImageLabel(state: StateInline): boolean {
  return imageLabelEnvironments.has(state.env);
}
const inlineSpan: RuleInline = (state, silent) => {
  // In a link label scan the ordinary brackets still need to balance.
  if (silent || state.src[state.pos] !== '[' || state.src[state.pos + 1] === '^' ||
    insideSpan.has(state) || isImageLabel(state)) return false;
  const end = state.md.helpers.parseLinkLabel(state, state.pos);
  if (end <= state.pos + 1 || state.src[end + 1] !== '{') return false;
  const match = classAtStart.exec(state.src.slice(end + 1, state.posMax));
  if (!match) return false;

  const limit = state.posMax;
  addClasses(state.push('class_span_open', 'span', 1), match[1]);
  state.pos++;
  state.posMax = end;
  insideSpan.add(state);
  try {
    state.md.inline.tokenize(state);
  } finally {
    insideSpan.delete(state);
  }
  state.push('class_span_close', 'span', -1);
  state.posMax = limit;
  state.pos = end + 1 + match[0].length;
  return true;
};

const styledBlockTokens = new Set([
  'paragraph_open', 'heading_open', 'blockquote_open', 'list_item_open',
  'bullet_list_open', 'ordered_list_open', 'table_open', 'fence', 'code_block', 'hr',
  'footnote_reference_open',
]);

interface ClassSuffix {
  readonly from: number;
  readonly literal: string;
  readonly list: string;
  readonly afterLineBreak: boolean;
}

function findSuffix(content: string): ClassSuffix | undefined {
  if (!content.endsWith('}')) return;
  const open = content.lastIndexOf('{');
  if (open < 0) return;
  const match = classAtStart.exec(content.slice(open));
  if (!match || match[0].length !== content.length - open) return;
  let from = open;
  while (content[from - 1] === ' ' || content[from - 1] === '\t') from--;
  const afterLineBreak = content[from - 1] === '\n';
  if (from === open && open !== 0 && !afterLineBreak) return;
  if (afterLineBreak) from--;
  return { from, literal: afterLineBreak ? match[0] : content.slice(from), list: match[1], afterLineBreak };
}

// The braces must be literal inline text. Code, escapes, links and spans tokenize separately.
function takeSuffix(inline: Token, suffix: ClassSuffix): boolean {
  const children = inline.children!;
  const last = children.at(-1);
  if (last?.type !== 'text' || !last.content.endsWith(suffix.literal)) return false;
  last.content = last.content.slice(0, -suffix.literal.length);
  if (!last.content) children.pop();
  if (suffix.afterLineBreak && ['softbreak', 'hardbreak'].includes(children.at(-1)?.type ?? '')) children.pop();
  inline.content = inline.content.slice(0, suffix.from);
  return true;
}

interface BlockScope {
  readonly token?: Token;
  previous?: Token;
}

const blockClasses: RuleCore = state => {
  const stack: BlockScope[] = [{}];
  const tokens = state.tokens;
  const result: Token[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const scope = stack.at(-1)!;
    const inline = tokens[index + 1];
    if (token.type === 'paragraph_open' && inline?.type === 'inline' && inline.content.startsWith('{')) {
      const previous = scope.previous;
      const suffix = findSuffix(inline.content);
      const previousRange = previous?.map;
      if (suffix?.from === 0 && previous && styledBlockTokens.has(previous.type) && previousRange && token.map &&
        token.map[0] >= previousRange[1] && takeSuffix(inline, suffix)) {
        // A class-only paragraph can address the previous sibling without ambiguity.
        addClasses(previous, suffix.list);
        previous.map = [previousRange[0], token.map[1]];
        index += 2;
        continue;
      }
    }

    if (token.type === 'inline' && scope.token && token.children?.length) {
      const owner = scope.token;
      const parent = stack.at(-2);
      const parentType = parent?.token?.type;
      const closesParent = tokens[index + 2]?.nesting === -1;
      const firstInItem = parentType === 'list_item_open' && parent?.previous === undefined;
      const endsContainer = closesParent && (parentType === 'blockquote_open' || parentType === 'list_item_open');
      const container = owner.type === 'paragraph_open' && (firstInItem || endsContainer) ? parent?.token : undefined;
      const suffix = findSuffix(token.content);
      const acceptsEmpty = container || ['heading_open', 'th_open', 'td_open'].includes(owner.type);
      if (suffix && (suffix.from > 0 || acceptsEmpty) && takeSuffix(token, suffix)) {
        if (suffix.afterLineBreak) {
          addClasses(owner, suffix.list);
          const parentSuffix = container && findSuffix(token.content);
          if (parentSuffix && takeSuffix(token, parentSuffix)) addClasses(container, parentSuffix.list);
        } else {
          addClasses(container ?? owner, suffix.list);
        }
      }
    }

    result.push(token);
    if (token.nesting === 1) {
      stack.push({ token });
    } else if (token.nesting === -1 && stack.length > 1) {
      stack.pop();
      stack.at(-1)!.previous = scope.token;
    } else if (token.block && token.type !== 'inline') {
      scope.previous = token;
    }
  }
  state.tokens = result;
};

export const markdownAttrs: PluginSimple = markdownIt => {
  markdownIt.inline.ruler.before('link', 'class_span', inlineSpan);
  wrapMarkdownRule(markdownIt.inline.ruler, 'image', original => (state, silent) => {
    if (silent || state.src[state.pos] !== '!' || imageLabelEnvironments.has(state.env)) {
      return original(state, silent);
    }
    imageLabelEnvironments.add(state.env);
    try {
      return original(state, silent);
    } finally {
      imageLabelEnvironments.delete(state.env);
    }
  });
  markdownIt.core.ruler.before('text_join', 'block_classes', blockClasses);
};
