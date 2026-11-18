export type TokenKind = 'word' | 'string' | '!' | '==' | '!=' | '&&' | '||' | '(' | ')' | 'end';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly offset: number;
}

// Unquoted words take the same characters as VS Code's scanner, except `<` and `>`, so comparisons stay errors.
const token = /\s+|'[^']*'|==|!=|&&|\|\||[!()]|[\p{L}\p{N}_.$:\/+#%\-\\*?\[\]^,@;"]+/uy;

export function scan(text: string): Token[] {
  const tokens: Token[] = [];
  for (let offset = 0; offset < text.length;) {
    token.lastIndex = offset;
    const match = token.exec(text);
    if (!match) {
      throw new SyntaxError(`Unexpected character at ${offset + 1}: ${text[offset]}`);
    }

    const value = match[0];
    if (value[0] === "'") {
      tokens.push({ kind: 'string', text: value.slice(1, -1), offset });
    } else if (!/^\s/u.test(value)) {
      const kind = /^[=!&|()]/u.test(value) ? value as TokenKind : 'word';
      tokens.push({ kind, text: value, offset });
    }
    offset = token.lastIndex;
  }
  tokens.push({ kind: 'end', text: '', offset: text.length });
  return tokens;
}
