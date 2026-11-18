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

export class ContextKeyExpr implements ContextKeyExpression {
  private constructor(
    private readonly test: (context: IContext) => boolean,
    private readonly dependencies: readonly string[],
    private readonly text: string,
    private readonly precedence: number,
  ) {}

  static deserialize(text: string | undefined): ContextKeyExpression | undefined {
    return text?.trim() ? new Parser().parse(text) : undefined;
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
    return new ContextKeyExpr(context => !this.evaluate(context), this.dependencies, '!' + this.format(4), 4);
  }
}

export class Parser {
  private tokens: Token[] = [];
  private index = 0;
  private errors: string[] = [];

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
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      this.errors.push(error.message);
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

  private expect(kind: TokenKind): Token {
    const token = this.take(kind);
    if (!token) {
      const actual = this.tokens[this.index];
      throw new SyntaxError(`Expected ${kind} at ${actual.offset + 1}, got ${actual.text || 'end of input'}`);
    }
    return token;
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
    const operator = this.take('==') ?? this.take('!=');
    if (!operator) {
      return left.expression;
    }
    if (!left.key) {
      throw new SyntaxError(`Expected a context key before ${operator.text} at ${operator.offset + 1}`);
    }
    const right = this.take('string') ?? this.expect('word');
    const value = right.kind === 'word' && (right.text === 'true' || right.text === 'false')
      ? right.text === 'true' : right.text;
    return operator.kind === '==' ? ContextKeyExpr.equals(left.key, value) : ContextKeyExpr.notEquals(left.key, value);
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
    const { text } = this.expect('word');
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
