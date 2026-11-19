import { normalize } from './path.js';

export interface IRelativePattern {
  readonly base: string;
  readonly pattern: string;
}

type Glob = string | IRelativePattern;
type Matcher = (path: string) => boolean;
type Segment = Matcher | '**';

const maxPatternBytes = 4096;
const maxAlternatives = 100;

export function match(pattern: Glob, path: string): boolean {
  return parse(pattern)(path);
}

export function parse(glob: Glob): Matcher {
  const pattern = typeof glob === 'string' ? glob : glob.pattern;
  const base = typeof glob === 'string' ? undefined : normalize(glob.base);
  if (new TextEncoder().encode(pattern).length > maxPatternBytes) {
    throw new RangeError('Glob pattern exceeds 4096 bytes');
  }
  if (!pattern) {
    return () => false;
  }
  const alternatives = expandBraces(pattern).map(alternative => ({
    absolute: alternative.startsWith('/'),
    segments: alternative.split('/').filter(segment => segment && segment !== '.').map(compileSegment),
  }));
  return candidate => {
    let path = normalize(candidate);
    if (base !== undefined) {
      const prefix = base === '/' ? base : base + '/';
      if (path !== base && !path.startsWith(prefix)) {
        return false;
      }
      path = path === base ? '' : path.slice(prefix.length);
    }
    const segments = path.split('/').filter(Boolean);
    const absolute = path.startsWith('/');
    return alternatives.some(alternative =>
      (alternative.absolute === absolute || (absolute && alternative.segments[0] === '**'))
      && matchSegments(alternative.segments, segments));
  };
}

function expandBraces(pattern: string): string[] {
  const stack = [pattern];
  const expanded: string[] = [];
  while (stack.length) {
    const current = stack.pop()!;
    const group = braceGroup(current);
    if (!group) {
      expanded.push(current);
      continue;
    }
    const { start, end, alternatives } = group;
    if (stack.length + expanded.length + alternatives.length > maxAlternatives) {
      throw new RangeError('Glob pattern exceeds 100 brace alternatives');
    }
    for (const alternative of alternatives) {
      stack.push(current.slice(0, start) + alternative + current.slice(end + 1));
    }
  }
  return expanded;
}

function braceGroup(pattern: string): { start: number; end: number; alternatives: string[] } | undefined {
  const openings: { start: number; commas: number[] }[] = [];
  let match: { start: number; end: number; commas: number[] } | undefined;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end >= 0) {
        index = end;
      }
    } else if (character === '{') {
      openings.push({ start: index, commas: [] });
    } else if (character === ',') {
      openings.at(-1)?.commas.push(index);
    } else if (character === '}') {
      const group = openings.pop();
      if (group?.commas.length && (!match || group.start < match.start)) {
        match = { ...group, end: index };
      }
      if (match && !openings.length) {
        break;
      }
    }
  }
  if (match) {
    const { start, end, commas } = match;
    const starts = [start, ...commas];
    return { start, end, alternatives: [...commas, end].map((stop, i) => pattern.slice(starts[i] + 1, stop)) };
  }
}

function compileSegment(segment: string): Segment {
  if (segment === '**') {
    return '**';
  }
  if (!/[*?\[]/.test(segment)) {
    return path => path === segment;
  }
  const tokens: ('*' | Matcher)[] = [];
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index];
    if (character === '*') {
      if (tokens.at(-1) !== '*') {
        tokens.push('*');
      }
      continue;
    }
    if (character === '?') {
      tokens.push(() => true);
      continue;
    }
    if (character === '[') {
      const end = segment.indexOf(']', index + 1);
      if (end > index + 1) {
        const source = segment.slice(index + 1, end);
        const negated = source.startsWith('!');
        const content = (negated ? source.slice(1) : source).replace(/[\\^\[]/g, '\\$&');
        if (content) {
          try {
            const characterClass = new RegExp(`[${negated ? '^' : ''}${content}]`);
            tokens.push(value => characterClass.test(value));
            index = end;
            continue;
          } catch {
            // Invalid ranges are treated literally.
          }
        }
      }
    }
    tokens.push(value => value === character);
  }
  return path => matchSequence(tokens, path, '*');
}

function matchSegments(pattern: readonly Segment[], path: readonly string[]): boolean {
  return matchSequence(pattern, path, '**');
}

/** Iterate reachable prefix lengths. A wildcard extends its own row, so no branch is revisited. */
function matchSequence(
  pattern: readonly (string | Matcher)[], input: ArrayLike<string>, wildcard: string,
): boolean {
  let previous = new Uint8Array(input.length + 1);
  let current = new Uint8Array(input.length + 1);
  previous[0] = 1;
  for (const token of pattern) {
    const repeat = token === wildcard;
    current[0] = repeat ? previous[0] : 0;
    for (let index = 1; index <= input.length; index++) {
      current[index] = repeat
        ? previous[index] || current[index - 1]
        : Number(previous[index - 1] && typeof token === 'function' && token(input[index - 1]));
    }
    [previous, current] = [current, previous];
  }
  return previous[input.length] === 1;
}
