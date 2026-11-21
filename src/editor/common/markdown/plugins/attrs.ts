import type { PluginSimple } from 'markdown-it';
import type { RuleCore } from 'markdown-it/lib/parser_core.mjs';
import type { RuleInline } from 'markdown-it/lib/parser_inline.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type Token from 'markdown-it/lib/token.mjs';

const classList = /\{(\.[a-z][a-z0-9-]*(?:[ \t]+\.[a-z][a-z0-9-]*)*)\}/;
const classAtStart = new RegExp(`^${classList.source}`);
const classAtEnd = /(?:^|\n[ \t]*|[ \t]+)\{(\.[a-z][a-z0-9-]*(?:[ \t]+\.[a-z][a-z0-9-]*)*)\}$/;

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
const inlineSpan: RuleInline = (state, silent) => {
  // In a link label scan the ordinary brackets still need to balance.
  if (silent || state.src[state.pos] !== '[' || insideSpan.has(state)) return false;
  const end = state.md.helpers.parseLinkLabel(state, state.pos);
  if (end <= state.pos + 1 || state.src[end + 1] !== '{') return false;
  const match = classAtStart.exec(state.src.slice(end + 1, state.posMax));
  if (!match) return false;

  const limit = state.posMax;
  addClasses(state.push('class_span_open', 'span', 1), match[1]);
  state.pos++;
  state.posMax = end;
  insideSpan.add(state);
  state.md.inline.tokenize(state);
  insideSpan.delete(state);
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

// The suffix must be literal text from the inline lexer. In particular, a code, escaped
// character, link or span token never provides the braces of a block attribute.
function takeSuffix(inline: Token): RegExpExecArray | null {
  const match = classAtEnd.exec(inline.content);
  const children = inline.children!;
  const last = children.at(-1);
  if (!match || last?.type !== 'text') return null;
  const afterLineBreak = match[0].startsWith('\n');
  const literal = afterLineBreak ? match[0].trimStart() : match[0];
  if (!last.content.endsWith(literal)) return null;
  last.content = last.content.slice(0, -literal.length);
  if (!last.content) children.pop();
  if (afterLineBreak && ['softbreak', 'hardbreak'].includes(children.at(-1)?.type ?? '')) children.pop();
  inline.content = inline.content.slice(0, match.index);
  return match;
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
      const match = classAtStart.exec(inline.content);
      const previousRange = previous?.map;
      if (match?.[0] === inline.content && previous && styledBlockTokens.has(previous.type) && previousRange && token.map &&
        token.map[0] >= previousRange[1] && takeSuffix(inline)) {
        // A class-only paragraph can address the previous sibling without ambiguity.
        addClasses(previous, match[1]);
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
      const match = classAtEnd.exec(token.content);
      if (match && (match.index > 0 || container || owner.type === 'heading_open' || owner.type === 'th_open' || owner.type === 'td_open') && takeSuffix(token)) {
        if (match[0].startsWith('\n')) {
          addClasses(owner, match[1]);
          const parentSuffix = container && takeSuffix(token);
          if (parentSuffix) addClasses(container, parentSuffix[1]);
        } else {
          addClasses(container ?? owner, match[1]);
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
  markdownIt.inline.ruler.after('image', 'class_span', inlineSpan);
  markdownIt.core.ruler.before('text_join', 'block_classes', blockClasses);
};
