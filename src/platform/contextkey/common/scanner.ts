export type TokenKind = 'word' | 'string' | 'regex' | 'in' | 'not' | '!' | '==' | '!=' | '=~'
  | '<' | '<=' | '>' | '>=' | '&&' | '||' | '(' | ')' | 'error' | 'end';

export interface Token {
  readonly kind: TokenKind;
  /** The lexeme; a quoted string's text is without its quotes, a regex keeps its slashes and flags. */
  readonly text: string;
  readonly offset: number;
  /** Why an `error` token could not be read. */
  readonly message?: string;
}

// Unquoted words take the same characters as VS Code's scanner. A word cannot start with `<`, `>` or `/`
// (those start an operator or a regex), but may contain them, so `fee.bee<K-loo+1>` stays one key.
const word = /[\p{L}\p{N}_.$:\/+#%\-\\*?\[\]^,@;"<>]+/uy;
const regexFlags = /[igsmyu]*/y;

// Longest first, so `===` is not read as `==` followed by a stray `=`.
const operators: readonly [string, TokenKind][] = [
  // VS Code reads `===` and `!==` as `==` and `!=`.
  ['===', '=='], ['!==', '!='],
  ['==', '=='], ['!=', '!='], ['=~', '=~'], ['<=', '<='], ['>=', '>='], ['&&', '&&'], ['||', '||'],
  ['<', '<'], ['>', '>'], ['!', '!'], ['(', '('], [')', ')'],
];

const hints: Readonly<Record<string, string>> = {
  '=': 'Did you mean == or =~?',
  '&': 'Did you mean &&?',
  '|': 'Did you mean ||?',
};

/**
 * Splits a `when` clause into tokens. It never throws: what it cannot read becomes an `error` token, which the
 * parser reports, or, after `=~`, glues back into a regex the way VS Code does for unescaped slashes.
 */
export function scan(text: string): Token[] {
  const tokens: Token[] = [];
  const error = (offset: number, lexeme: string, message: string) =>
    tokens.push({ kind: 'error', text: lexeme, offset, message: `Unexpected ${lexeme} at ${offset + 1}. ${message}` });

  for (let offset = 0; offset < text.length;) {
    const char = text[offset];
    if (/\s/u.test(char)) {
      offset++;
      continue;
    }

    if (char === "'") {
      const close = text.indexOf("'", offset + 1);
      if (close < 0) {
        error(offset, text.slice(offset), 'Did you forget to open or close the quote?');
        break;
      }
      tokens.push({ kind: 'string', text: text.slice(offset + 1, close), offset });
      offset = close + 1;
      continue;
    }

    if (char === '/') {
      const end = regexEnd(text, offset);
      if (end < 0) {
        error(offset, text.slice(offset), "Did you forget to escape the '/' (slash) character? Write it as \\/.");
        break;
      }
      regexFlags.lastIndex = end;
      regexFlags.exec(text);
      tokens.push({ kind: 'regex', text: text.slice(offset, regexFlags.lastIndex), offset });
      offset = regexFlags.lastIndex;
      continue;
    }

    const operator = operators.find(([lexeme]) => text.startsWith(lexeme, offset));
    if (operator) {
      tokens.push({ kind: operator[1], text: operator[0], offset });
      offset += operator[0].length;
      continue;
    }

    word.lastIndex = offset;
    const match = word.exec(text);
    if (match) {
      const value = match[0];
      tokens.push({ kind: value === 'in' || value === 'not' ? value : 'word', text: value, offset });
      offset = word.lastIndex;
      continue;
    }

    // VS Code silently skips a character it has no rule for; reporting it is kinder to the author.
    error(offset, char, hints[char] ?? 'This character is not part of a when clause.');
    offset++;
  }
  tokens.push({ kind: 'end', text: '', offset: text.length });
  return tokens;
}

/** The index after the slash that closes the regex opened at `start`, or -1. Escaped slashes and slashes in a
 * character class (`/x\/y/`, `/[/]/`) belong to the pattern. */
function regexEnd(text: string, start: number): number {
  let escaped = false;
  let inClass = false;
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '[') {
      inClass = true;
    } else if (char === ']') {
      inClass = false;
    } else if (char === '/' && !inClass) {
      return index + 1;
    }
  }
  return -1;
}
