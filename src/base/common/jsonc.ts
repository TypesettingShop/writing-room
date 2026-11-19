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
  /** The index of the value's first token. */
  readonly startIndex: number;
  readonly end: Token;
  readonly comma?: Token;
}

interface ObjectNode {
  readonly open: Token;
  readonly close: Token;
  readonly properties: readonly Property[];
}

/** The properties of the object whose `{` is `tokens[open]`. The text is known to parse. */
function objectNode(text: string, tokens: readonly Token[], open: number): ObjectNode {
  const properties: Property[] = [];
  let i = open + 1;
  while (tokens[i].kind !== '}') {
    const key = tokens[i];
    const startIndex = i + 2;
    const start = tokens[startIndex];
    i = startIndex + 1;
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
    properties.push({ name: JSON.parse(text.slice(key.start, key.end)) as string, key, start, startIndex, end, comma });
  }
  return { open: tokens[open], close: tokens[i], properties };
}

function lineStart(text: string, offset: number): number {
  return Math.max(text.lastIndexOf('\r', offset - 1), text.lastIndexOf('\n', offset - 1)) + 1;
}

function lineEnd(text: string, offset: number): number {
  const end = text.slice(offset).search(/\r\n|\r|\n/);
  return end < 0 ? text.length : offset + end;
}

function newlineOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : text.includes('\n') ? '\n' : text.includes('\r') ? '\r' : '\n';
}

/** One level of indentation as the text uses it: a tab, or the first indented line's spaces. */
function indentUnit(text: string): string {
  const indent = /(?:^|[\r\n])([\t ]+)["/}\]]/.exec(text)?.[1];
  return indent?.startsWith('\t') ? '\t' : indent ? ' '.repeat(Math.min(indent.length, 8)) : '  ';
}

function serialize(value: unknown, indent: string, unit: string, newline: string): string {
  const text = JSON.stringify(value, null, unit);
  if (text === undefined) {
    throw new TypeError('Expected a JSON value.');
  }
  return text.replace(/\n/g, newline + indent);
}

function parsedObject(text: string): { readonly tokens: readonly Token[]; readonly root: ObjectNode } {
  const { sanitized, tokens } = scan(text);
  const root: unknown = JSON.parse(sanitized);
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new SyntaxError('Expected a JSON object.');
  }
  return { tokens, root: objectNode(text, tokens, 0) };
}

/** Adds `name: value` as the last property of `object`, in the layout its properties already have. */
function insertProperty(text: string, object: ObjectNode, name: string, value: unknown): string {
  const { open, close, properties } = object;
  const closeLine = lineStart(text, close.start);
  const closeIndent = text.slice(closeLine, close.start);
  const multiline = closeLine > open.start && /^[\t ]*$/.test(closeIndent);
  const last = properties.at(-1);
  const propertyIndent = last && text.slice(lineStart(text, last.key.start), last.key.start);
  const unit = indentUnit(text);
  const indent = propertyIndent && /^[\t ]+$/.test(propertyIndent) ? propertyIndent : closeIndent + unit;
  const newline = newlineOf(text);
  const at = multiline ? closeLine : close.start;
  const separator = at > open.end && !whitespace.test(text[at - 1]) ? ' ' : '';
  const prefix = last && !last.comma
    ? text.slice(0, last.end.end) + ',' + text.slice(last.end.end, at)
    : text.slice(0, at);
  const field = JSON.stringify(name) + ': ' + serialize(value, multiline ? indent : '', multiline ? unit : '', multiline ? newline : '')
    + (last?.comma ? ',' : '');
  return prefix + (multiline ? indent + field + newline : separator + field) + text.slice(at);
}

/** Removes `property` from `object` with its separator, and its line when nothing else is on it. */
function removeProperty(text: string, object: ObjectNode, property: Property): string {
  const index = object.properties.indexOf(property);
  const previous = object.properties[index - 1];
  // The last property without a comma of its own takes the comma before it along; comments stay.
  const separator = !property.comma && previous?.comma ? previous.comma : undefined;
  let start = property.key.start;
  let end = (property.comma ?? property.end).end;
  const before = lineStart(text, start);
  const after = lineEnd(text, end);
  if (!/^[\t ]*$/.test(text.slice(end, after))) {
    // A comment after it on the line stays where the property started.
    end += /^[\t ]*/.exec(text.slice(end))![0].length;
  } else if (/^[\t ]*$/.test(text.slice(before, start))) {
    start = before;
    end = after + (text.startsWith('\r\n', after) ? 2 : after < text.length ? 1 : 0);
  }
  return separator
    ? text.slice(0, separator.start) + text.slice(separator.end, start) + text.slice(end)
    : text.slice(0, start) + text.slice(end);
}

/**
 * Sets the property at `path` (a top-level key, or a key inside a top-level object such as `[markdown]`)
 * to `value`, preserving comments, trailing commas and every other property. The last occurrence of a
 * duplicated key is the one changed. `undefined` removes every occurrence.
 */
export function setJSONCProperty(text: string, path: string | readonly string[], value: unknown): string {
  const keys = typeof path === 'string' ? [path] : path;
  if (!keys.length) {
    throw new TypeError('Expected a property path.');
  }
  let { tokens, root } = parsedObject(text);
  let object = root;
  for (let depth = 0; depth < keys.length - 1; depth++) {
    const property = [...object.properties].reverse().find(entry => entry.name === keys[depth]);
    if (!property || property.start.kind !== '{') {
      if (value === undefined) {
        return text;
      }
      // Build the rest of the path as one new object value.
      const nested = keys.slice(depth + 1).reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
      return property
        ? replaceValue(text, property, nested)
        : insertProperty(text, object, keys[depth], nested);
    }
    object = objectNode(text, tokens, property.startIndex);
  }
  const name = keys[keys.length - 1];
  if (value === undefined) {
    const parents = keys.slice(0, -1);
    for (;;) {
      const property = object.properties.find(entry => entry.name === name);
      if (!property) {
        return text;
      }
      text = removeProperty(text, object, property);
      ({ tokens, root } = parsedObject(text));
      object = root;
      for (const parent of parents) {
        const entry = [...object.properties].reverse().find(candidate => candidate.name === parent)!;
        object = objectNode(text, tokens, entry.startIndex);
      }
    }
  }
  const property = [...object.properties].reverse().find(entry => entry.name === name);
  return property ? replaceValue(text, property, value) : insertProperty(text, object, name, value);
}

function replaceValue(text: string, property: Property, value: unknown): string {
  // Spread over lines only when the property has a line of its own.
  const indent = text.slice(lineStart(text, property.key.start), property.key.start);
  const serialized = /^[\t ]*$/.test(indent) ? serialize(value, indent, indentUnit(text), newlineOf(text)) : serialize(value, '', '', '');
  return text.slice(0, property.start.start) + serialized + text.slice(property.end.end);
}
