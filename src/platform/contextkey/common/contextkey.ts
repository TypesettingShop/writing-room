import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';
import { scan } from './scanner.js';
import type { Token, TokenKind } from './scanner.js';

export interface IContext {
  getValue<T = unknown>(key: string): T | undefined;
}

export type ContextKeyValue = string | number | boolean | null | undefined
  | readonly ContextKeyValue[] | { readonly [key: string]: ContextKeyValue };

export interface IContextKey<T extends ContextKeyValue> {
  set(value: T): void;
  reset(): void;
  get(): T | undefined;
}

export interface IContextKeyChangeEvent {
  affectsSome(keys: ReadonlySet<string>): boolean;
}

export const IContextKeyService = createDecorator<IContextKeyService>('contextKeyService');

export interface IContextKeyService extends BrandedService, IDisposable {
  readonly onDidChangeContext: Event<IContextKeyChangeEvent>;
  createKey<T extends ContextKeyValue>(key: string, defaultValue: T | undefined): IContextKey<T>;
  createScoped(target?: HTMLElement): IContextKeyService;
  getContextKeyValue<T = unknown>(key: string): T | undefined;
  getContext(target: EventTarget | null): IContext;
  getScopedContextKeyService(target: EventTarget | null): IContextKeyService;
  contextMatchesRules(rules: ContextKeyExpression | undefined): boolean;
}

export interface ContextKeyExpression {
  evaluate(context: IContext): boolean;
  keys(): string[];
  negate(): ContextKeyExpression;
  serialize(): string;
}

type ComparisonOperator = '<' | '<=' | '>' | '>=';

// Negating a size comparison flips it rather than wrapping it in `!`, as VS Code does, so `!(n > 1)` is
// `n <= 1` and stays false when `n` is missing or not a number.
const complement: Readonly<Record<ComparisonOperator, ComparisonOperator>> = { '<': '>=', '<=': '>', '>': '<=', '>=': '<' };

const compare: Readonly<Record<ComparisonOperator, (left: number, right: number) => boolean>> = {
  '<': (left, right) => left < right,
  '<=': (left, right) => left <= right,
  '>': (left, right) => left > right,
  '>=': (left, right) => left >= right,
};

/** A context value as text, the way `RegExp.test` and `parseFloat` would coerce it, without ever throwing. */
function coerceToText(value: unknown): string | undefined {
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

export class ContextKeyExpr implements ContextKeyExpression {
  private constructor(
    private readonly test: (context: IContext) => boolean,
    private readonly dependencies: readonly string[],
    private readonly text: string,
    private readonly precedence: number,
    private readonly negation?: () => ContextKeyExpression,
  ) {}

  static deserialize(text: string | undefined): ContextKeyExpression | undefined {
    // Like VS Code's `deserialize`, this reads only well-formed regexes; `Parser` itself also repairs
    // the unescaped slashes extensions write.
    return text?.trim() ? new Parser({ regexParsingWithErrorRecovery: false }).parse(text) : undefined;
  }

  static true(): ContextKeyExpression {
    return new ContextKeyExpr(() => true, [], 'true', 4);
  }

  static false(): ContextKeyExpression {
    return new ContextKeyExpr(() => false, [], 'false', 4);
  }

  static has(key: string): ContextKeyExpression {
    return new ContextKeyExpr(context => Boolean(context.getValue(key)), [key], key, 4);
  }

  static not(key: string): ContextKeyExpression {
    return this.has(key).negate();
  }

  static equals(key: string, value: string | number | boolean | null | undefined): ContextKeyExpression {
    if (typeof value === 'boolean') {
      return value ? this.has(key) : this.not(key);
    }
    // When expressions compare strings with coercion, as in VS Code.
    return new ContextKeyExpr(context => context.getValue(key) == value, [key], `${key} == '${value}'`, 3);
  }

  static notEquals(key: string, value: string | number | boolean | null | undefined): ContextKeyExpression {
    if (typeof value === 'boolean') {
      return value ? this.not(key) : this.has(key);
    }
    return new ContextKeyExpr(context => context.getValue(key) != value, [key], `${key} != '${value}'`, 3);
  }

  static regex(key: string, value: RegExp): ContextKeyExpression {
    // `g` and `y` make `test` remember where it stopped, so the same value could match on one evaluation and
    // not the next; VS Code's parser drops them for that reason.
    const regexp = /[gy]/.test(value.flags) ? new RegExp(value.source, value.flags.replace(/[gy]/g, '')) : value;
    // A missing or non-string value is matched as its text (`undefined`, `true`, `1,2`), as VS Code does.
    return new ContextKeyExpr(context => {
      const text = coerceToText(context.getValue(key));
      return text !== undefined && regexp.test(text);
    }, [key], `${key} =~ /${regexp.source}/${regexp.flags}`, 3);
  }

  /** True when the value of `key` is an item of the array, or a property of the object, held by `valueKey`. */
  static in(key: string, valueKey: string): ContextKeyExpression {
    return new ContextKeyExpr(context => {
      const source = context.getValue(valueKey);
      const item = context.getValue(key);
      if (Array.isArray(source)) {
        return source.includes(item);
      }
      return typeof item === 'string' && typeof source === 'object' && source !== null && Object.hasOwn(source, item);
    }, [...new Set([key, valueKey])], `${key} in '${valueKey}'`, 3, () => this.notIn(key, valueKey));
  }

  static notIn(key: string, valueKey: string): ContextKeyExpression {
    const included = this.in(key, valueKey);
    return new ContextKeyExpr(context => !included.evaluate(context), included.keys(),
      `${key} not in '${valueKey}'`, 3, () => included);
  }

  static greater(key: string, value: number | string): ContextKeyExpression {
    return this.compare(key, '>', value);
  }

  static greaterEquals(key: string, value: number | string): ContextKeyExpression {
    return this.compare(key, '>=', value);
  }

  static smaller(key: string, value: number | string): ContextKeyExpression {
    return this.compare(key, '<', value);
  }

  static smallerEquals(key: string, value: number | string): ContextKeyExpression {
    return this.compare(key, '<=', value);
  }

  private static compare(key: string, operator: ComparisonOperator, value: number | string): ContextKeyExpression {
    const bound = typeof value === 'number' ? value : parseFloat(value);
    // A bound that is not a number never matches, in either direction. It is written quoted so that
    // parsing the text again gives the same string back even when it holds spaces.
    const numeric = !Number.isNaN(bound);
    const text = `${key} ${operator} ${numeric ? bound : `'${value}'`}`;
    return new ContextKeyExpr(context => {
      if (!numeric) {
        return false;
      }
      const actual = context.getValue(key);
      // `parseFloat` of a missing or non-numeric value is NaN, which compares false.
      const left = typeof actual === 'number' ? actual : parseFloat(coerceToText(actual) ?? '');
      return compare[operator](left, bound);
    }, [key], text, 3, () => this.compare(key, complement[operator], value));
  }

  static and(...terms: (ContextKeyExpression | undefined)[]): ContextKeyExpression | undefined {
    return this.combine(terms, '&&', 2, (items, context) => items.every(term => term.evaluate(context)));
  }

  static or(...terms: (ContextKeyExpression | undefined)[]): ContextKeyExpression | undefined {
    return this.combine(terms, '||', 1, (items, context) => items.some(term => term.evaluate(context)));
  }

  private static combine(
    terms: (ContextKeyExpression | undefined)[],
    operator: string,
    precedence: number,
    test: (terms: ContextKeyExpression[], context: IContext) => boolean,
  ): ContextKeyExpression | undefined {
    const items = terms.filter(term => term !== undefined);
    if (items.length < 2) {
      return items[0];
    }
    const text = items.map(item => item instanceof ContextKeyExpr ? item.format(precedence) : `(${item.serialize()})`);
    return new ContextKeyExpr(context => test(items, context), [...new Set(items.flatMap(item => item.keys()))],
      text.join(` ${operator} `), precedence);
  }

  private format(precedence: number): string {
    return this.precedence < precedence ? `(${this.text})` : this.text;
  }

  evaluate(context: IContext): boolean { return this.test(context); }
  keys(): string[] { return [...this.dependencies]; }
  serialize(): string { return this.text; }

  negate(): ContextKeyExpression {
    return this.negation?.()
      ?? new ContextKeyExpr(context => !this.evaluate(context), this.dependencies, '!' + this.format(4), 4);
  }
}

export interface ParserConfig {
  /**
   * Reads a regex whose slashes are not escaped (`/src//`) by gluing the tokens after it back on, as VS Code's
   * parser does by default for the extensions that write them. On by default; `ContextKeyExpr.deserialize`
   * turns it off, as VS Code's does.
   */
  readonly regexParsingWithErrorRecovery: boolean;
}

/** The depth of unescaped parentheses outside character classes a regex lexeme leaves open. */
function groupDepth(lexeme: string): number {
  let depth = 0;
  let escaped = false;
  let inClass = false;
  for (const char of lexeme) {
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (inClass) {
      inClass = char !== ']';
    } else if (char === '[') {
      inClass = true;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
    }
  }
  return depth;
}

export class Parser {
  private tokens: Token[] = [];
  private index = 0;
  private errors: string[] = [];

  constructor(private readonly config: ParserConfig = { regexParsingWithErrorRecovery: true }) {}

  get parsingErrors(): readonly string[] { return this.errors; }

  parse(text: string): ContextKeyExpression | undefined {
    this.errors = [];
    this.index = 0;
    try {
      this.tokens = scan(text);
      const expression = this.parseOr();
      this.expect('end');
      return expression;
    } catch (error) {
      // A `when` clause comes from an extension; whatever goes wrong reading it (even nesting deep enough to
      // overflow the stack) is that clause's error, never one that stops the next contribution.
      this.errors.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  private take(kind: TokenKind): Token | undefined {
    const token = this.tokens[this.index];
    if (token.kind === kind) {
      this.index++;
      return token;
    }
    return undefined;
  }

  private expect(kind: TokenKind, description: string = kind): Token {
    return this.take(kind) ?? this.fail(description);
  }

  private fail(expected: string): never {
    const actual = this.tokens[this.index];
    if (actual.message) {
      throw new SyntaxError(actual.message);
    }
    throw new SyntaxError(`Expected ${expected} at ${actual.offset + 1}, got ${actual.text || 'end of input'}`);
  }

  private parseOr(): ContextKeyExpression {
    const terms = [this.parseAnd()];
    while (this.take('||')) {
      terms.push(this.parseAnd());
    }
    return ContextKeyExpr.or(...terms)!;
  }

  private parseAnd(): ContextKeyExpression {
    const terms = [this.parseComparison()];
    while (this.take('&&')) {
      terms.push(this.parseComparison());
    }
    return ContextKeyExpr.and(...terms)!;
  }

  private parseComparison(): ContextKeyExpression {
    const left = this.parseUnary();
    const operator = this.tokens[this.index];
    if (!['==', '!=', '=~', '<', '<=', '>', '>=', 'in', 'not'].includes(operator.kind)) {
      return left.expression;
    }
    // Only a bare key can be compared: `!a == b` and `(a) in b` are errors, as in VS Code.
    if (!left.key) {
      throw new SyntaxError(`Expected a context key before ${operator.text} at ${operator.offset + 1}`);
    }
    this.index++;
    const key = left.key;
    switch (operator.kind) {
      case '=~':
        return this.parseRegex(key);
      case 'not':
        this.expect('in', "'in' after 'not'");
        return ContextKeyExpr.notIn(key, this.parseValue().text);
      case 'in':
        return ContextKeyExpr.in(key, this.parseValue().text);
      case '<':
        return ContextKeyExpr.smaller(key, this.parseValue().text);
      case '<=':
        return ContextKeyExpr.smallerEquals(key, this.parseValue().text);
      case '>':
        return ContextKeyExpr.greater(key, this.parseValue().text);
      case '>=':
        return ContextKeyExpr.greaterEquals(key, this.parseValue().text);
    }
    const right = this.parseValue();
    const value = !right.quoted && (right.text === 'true' || right.text === 'false') ? right.text === 'true' : right.text;
    return operator.kind === '==' ? ContextKeyExpr.equals(key, value) : ContextKeyExpr.notEquals(key, value);
  }

  private parseValue(): { text: string; quoted: boolean } {
    // `in` is read as a value because extensions write `languageId == in`. A missing value is the empty string
    // (`foo == `), which extensions also rely on; the token after it is left for the caller to reject.
    const token = this.take('string') ?? this.take('word') ?? this.take('in');
    return { text: token?.text ?? '', quoted: token?.kind === 'string' };
  }

  private parseRegex(key: string): ContextKeyExpression {
    const first = this.tokens[this.index];
    if (first.kind === 'regex' || (this.config.regexParsingWithErrorRecovery && first.kind === 'error')) {
      const lexeme = this.readRegexLexeme();
      const close = lexeme.lastIndexOf('/');
      if (!lexeme.startsWith('/') || close <= 0) {
        throw new SyntaxError(first.message ?? `Expected a regular expression at ${first.offset + 1}, got ${lexeme}`);
      }
      return this.createRegex(key, lexeme.slice(1, close), lexeme.slice(close + 1).replace(/[gy]/g, ''), first);
    }
    const start = first.text.indexOf('/');
    const end = first.text.lastIndexOf('/');
    if (this.config.regexParsingWithErrorRecovery && first.kind === 'string' && start >= 0 && start !== end) {
      // Old when clauses quote the regex (`a =~ '/x/i'`); VS Code still reads those, with `i` as the only flag.
      this.index++;
      return this.createRegex(key, first.text.slice(start + 1, end), first.text[end + 1] === 'i' ? 'i' : '', first);
    }
    return this.fail('a regular expression');
  }

  /** The regex lexeme; with recovery, glued back together across the slashes that ended it too early. */
  private readRegexLexeme(): string {
    const parts = [this.tokens[this.index++].text];
    if (!this.config.regexParsingWithErrorRecovery) {
      return parts[0];
    }
    // Glue until `&&`, `||` or the `)` that closes a group the regex sits in. Unlike VS Code, an escaped
    // parenthesis or one in a character class (`(a =~ /\(/)`) does not count as a group.
    let depth = groupDepth(parts[0]);
    for (let token = this.tokens[this.index]; !['end', '&&', '||'].includes(token.kind); token = this.tokens[this.index]) {
      depth += token.kind === '(' ? 1 : token.kind === ')' ? -1 : token.kind === 'regex' ? groupDepth(token.text) : 0;
      if (depth < 0) {
        break;
      }
      parts.push(token.text);
      this.index++;
    }
    return parts.join('');
  }

  private createRegex(key: string, source: string, flags: string, token: Token): ContextKeyExpression {
    let regexp: RegExp;
    try {
      regexp = new RegExp(source, flags);
    } catch (error) {
      throw new SyntaxError(`Invalid regular expression at ${token.offset + 1}: ${error instanceof Error ? error.message : error}`);
    }
    return ContextKeyExpr.regex(key, regexp);
  }

  private parseUnary(): { expression: ContextKeyExpression; key?: string } {
    if (this.take('!')) {
      return { expression: this.parseUnary().expression.negate() };
    }
    if (this.take('(')) {
      const expression = this.parseOr();
      this.expect(')');
      return { expression };
    }
    const { text } = this.expect('word', 'a context key');
    if (text === 'true' || text === 'false') {
      return { expression: text === 'true' ? ContextKeyExpr.true() : ContextKeyExpr.false() };
    }
    return { expression: ContextKeyExpr.has(text), key: text };
  }
}

export class RawContextKey<T extends ContextKeyValue> {
  constructor(readonly key: string, readonly defaultValue: T | undefined, readonly description?: string) {}

  bindTo(service: IContextKeyService): IContextKey<T> {
    return service.createKey(this.key, this.defaultValue);
  }

  getValue(service: IContextKeyService): T | undefined { return service.getContextKeyValue<T>(this.key); }
  isEqualTo(value: string | number | boolean | null | undefined): ContextKeyExpression {
    return ContextKeyExpr.equals(this.key, value);
  }
  notEqualsTo(value: string | number | boolean | null | undefined): ContextKeyExpression {
    return ContextKeyExpr.notEquals(this.key, value);
  }
  toNegated(): ContextKeyExpression { return ContextKeyExpr.not(this.key); }
}
