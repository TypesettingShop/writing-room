type Punctuation = '{' | '}' | '[' | ']' | ':' | ',';
interface Token {
  readonly kind: Punctuation | 'string' | 'literal';
  readonly start: number;
  readonly end: number;
}

const whitespace = /[\t\r\n ]/;
const punctuation = '{}[]:,';

/** Keep source offsets by replacing comments and trailing commas with whitespace. */
function scan(text: string): { readonly sanitized: string; readonly tokens: readonly Token[] } {
  const sanitized = text.split('');
  const tokens: Token[] = [];
  const mask = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      if (text[i] !== '\r' && text[i] !== '\n') {
        sanitized[i] = ' ';
      }
    }
  };
  let offset = 0;
  if (text.charCodeAt(0) === 0xfeff) {
    mask(0, ++offset);
  }
  while (offset < text.length) {
    const start = offset;
    const c = text[offset++];
    if (whitespace.test(c)) {
      continue;
    }
    if (c === '/' && text[offset] === '/') {
      while (offset < text.length && text[offset] !== '\n' && text[offset] !== '\r') {
        offset++;
      }
      mask(start, offset);
      continue;
    }
    if (c === '/' && text[offset] === '*') {
      const end = text.indexOf('*/', offset + 1);
      if (end < 0) {
        throw new SyntaxError('Unterminated block comment.');
      }
      offset = end + 2;
      mask(start, offset);
      continue;
    }

    let kind: Token['kind'];
    if (c === '"') {
      kind = 'string';
      while (offset < text.length) {
        const next = text[offset++];
        if (next === '"') {
          break;
        }
        if (next === '\\' && offset < text.length) {
          offset++;
        }
      }
    } else if (punctuation.includes(c)) {
      kind = c as Punctuation;
      if (c === '}' || c === ']') {
        const comma = tokens.at(-1);
        const beforeComma = tokens.at(-2)?.kind;
        if (comma?.kind === ',' && beforeComma && beforeComma !== '{' && beforeComma !== '['
          && beforeComma !== ':' && beforeComma !== ',') {
          mask(comma.start, comma.end);
        }
      }
    } else {
      kind = 'literal';
      while (offset < text.length && !whitespace.test(text[offset]) && !punctuation.includes(text[offset])
        && text[offset] !== '"' && text[offset] !== '/') {
        offset++;
      }
    }
    tokens.push({ kind, start, end: offset });
  }
  return { sanitized: sanitized.join(''), tokens };
}

export function parseJSONC(text: string): unknown {
  try {
    return JSON.parse(scan(text).sanitized) as unknown;
  } catch {
    return undefined;
  }
}

interface Property {
  readonly name: string;
  readonly key: Token;
  readonly start: Token;
  readonly end: Token;
  readonly comma?: Token;
}

function rootProperties(text: string, tokens: readonly Token[]): Property[] {
  const properties: Property[] = [];
  for (let i = 1; i < tokens.length - 1;) {
    const key = tokens[i];
    const start = tokens[i + 2];
    i += 3;
    if (start.kind === '{' || start.kind === '[') {
      let depth = 1;
      while (depth > 0) {
        const kind = tokens[i++].kind;
        if (kind === '{' || kind === '[') {
          depth++;
        } else if (kind === '}' || kind === ']') {
          depth--;
        }
      }
    }
    const end = tokens[i - 1];
    const comma = tokens[i].kind === ',' ? tokens[i++] : undefined;
    properties.push({ name: JSON.parse(text.slice(key.start, key.end)) as string, key, start, end, comma });
  }
  return properties;
}

function lineStart(text: string, offset: number): number {
  return Math.max(text.lastIndexOf('\r', offset - 1), text.lastIndexOf('\n', offset - 1)) + 1;
}

/** Update the last occurrence of a top-level key, preserving the rest of the source. */
export function setJSONCProperty(text: string, key: string, value: boolean | number | string): string {
  const { sanitized, tokens } = scan(text);
  const root: unknown = JSON.parse(sanitized);
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new SyntaxError('Expected a JSON object.');
  }
  const properties = rootProperties(text, tokens);
  const property = [...properties].reverse().find(entry => entry.name === key);
  const serialized = JSON.stringify(value);
  if (property) {
    return text.slice(0, property.start.start) + serialized + text.slice(property.end.end);
  }

  const close = tokens[tokens.length - 1];
  const closeLine = lineStart(text, close.start);
  const closeIndent = text.slice(closeLine, close.start);
  const multiline = closeLine > tokens[0].start && /^[\t ]*$/.test(closeIndent);
  const last = properties.at(-1);
  const propertyIndent = last && text.slice(lineStart(text, last.key.start), last.key.start);
  const indent = propertyIndent && /^[\t ]+$/.test(propertyIndent) ? propertyIndent : closeIndent + '  ';
  const newline = text.includes('\r\n') ? '\r\n' : text.includes('\n') ? '\n' : '\r';
  const at = multiline ? closeLine : close.start;
  const separator = at > tokens[0].end && !whitespace.test(text[at - 1]) ? ' ' : '';
  const prefix = last && !last.comma
    ? text.slice(0, last.end.end) + ',' + text.slice(last.end.end, at)
    : text.slice(0, at);
  const field = JSON.stringify(key) + ': ' + serialized + (last?.comma ? ',' : '');
  return prefix + (multiline ? indent + field + newline : separator + field) + text.slice(at);
}
