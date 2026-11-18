import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { IContextKeyService } from '../common/contextkey.js';
import type {
  ContextKeyExpression, ContextKeyValue, IContext, IContextKey, IContextKeyChangeEvent,
} from '../common/contextkey.js';

class ScopedContextKeyService extends Disposable implements IContextKeyService, IContext {
  declare readonly _serviceBrand: undefined;
  private readonly values = new Map<string, ContextKeyValue>();
  private readonly changed = this._register(new Emitter<IContextKeyChangeEvent>());
  readonly onDidChangeContext = this.changed.event;

  constructor(
    private readonly scopes: WeakMap<HTMLElement, ScopedContextKeyService>,
    private readonly parent?: ScopedContextKeyService,
    target?: HTMLElement,
  ) {
    super();
    if (target) {
      if (scopes.has(target)) {
        throw new Error('The element already owns a context key scope.');
      }
      scopes.set(target, this);
      this._register(toDisposable(() => scopes.delete(target)));
    }
    if (parent) {
      this._register(parent.onDidChangeContext(event => this.changed.fire({
        affectsSome: keys => event.affectsSome(new Set([...keys].filter(key => !this.values.has(key)))),
      })));
    }
  }

  createKey<T extends ContextKeyValue>(key: string, defaultValue: T | undefined): IContextKey<T> {
    const update = (value: T | undefined) => {
      const before = this.getValue(key);
      if (value === undefined) {
        this.values.delete(key);
      } else {
        this.values.set(key, value);
      }
      if (!Object.is(before, this.getValue(key))) {
        this.changed.fire({ affectsSome: keys => keys.has(key) });
      }
    };
    update(defaultValue);
    return {
      set: update,
      reset: () => update(defaultValue),
      get: () => this.getValue<T>(key),
    };
  }

  createScoped(target?: HTMLElement): IContextKeyService {
    return new ScopedContextKeyService(this.scopes, this, target);
  }

  getValue<T = unknown>(key: string): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : this.parent?.getValue<T>(key);
  }

  getContextKeyValue<T = unknown>(key: string): T | undefined { return this.getValue<T>(key); }

  getScopedContextKeyService(target: EventTarget | null): ScopedContextKeyService {
    let node = target as Node | null;
    while (node?.nodeType) {
      const scope = this.scopes.get(node as HTMLElement);
      if (scope) {
        return scope;
      }
      node = node.parentNode ?? (node as ShadowRoot).host ?? null;
    }
    return this;
  }

  getContext(target: EventTarget | null): IContext { return this.getScopedContextKeyService(target); }

  contextMatchesRules(rules: ContextKeyExpression | undefined): boolean {
    return rules?.evaluate(this) ?? true;
  }
}

export class ContextKeyService extends ScopedContextKeyService {
  constructor() { super(new WeakMap()); }
}

registerSingleton(IContextKeyService, ContextKeyService);
