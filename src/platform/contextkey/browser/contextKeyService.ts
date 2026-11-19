import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../commands/common/commands.js';
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

/**
 * Whether `value` is something a context key may hold: a string, number, boolean, `null` or
 * `undefined`, or arrays and plain objects of those. Anything else (a function, a class instance, a
 * cycle) could not cross from an extension and is refused.
 */
export function isContextKeyValue(value: unknown, seen = new Set<object>()): value is ContextKeyValue {
  if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) {
    return true;
  }
  if (typeof value !== 'object' || seen.has(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  seen.add(value);
  const valid = Object.values(value).every(item => isContextKeyValue(item, seen));
  seen.delete(value);
  return valid;
}

/**
 * `setContext(key, value)`, as VS Code has it: sets a key in the workbench's own scope. A key an
 * extension sets this way stays after the extension is removed, as in VS Code.
 */
CommandsRegistry.registerCommand('setContext', (accessor, key: unknown, value: unknown) => {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('setContext needs a context key name.');
  }
  if (!isContextKeyValue(value)) {
    throw new Error(`setContext cannot set '${key}' to a value that is not plain data.`);
  }
  // A copy, so the caller changing its object later does not change the key behind the menus' backs.
  accessor.get(IContextKeyService).createKey(key, value === undefined ? undefined : structuredClone(value));
});
