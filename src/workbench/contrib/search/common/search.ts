import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import type { Event } from '../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { IRange } from '../../../../editor/common/model.js';

export interface IWorkspaceSymbol {
  readonly name: string;
  readonly containerName?: string;
  /** VS Code's `SymbolKind` value (0 File … 25 TypeParameter). */
  readonly kind: number;
  readonly tags?: readonly number[];
  /** A range is absent only for a provider that resolves; it is then resolved before opening. 1-based. */
  readonly location: { readonly uri: URI; readonly range?: IRange };
}

export interface IWorkspaceSymbolProvider {
  provideWorkspaceSymbols(search: string, token: CancellationToken): Promise<IWorkspaceSymbol[] | undefined>;
  resolveWorkspaceSymbol?(item: IWorkspaceSymbol, token: CancellationToken): Promise<IWorkspaceSymbol | undefined>;
  /**
   * The caller shows no result of this provider any more (the screen closed): free what is kept for
   * it. It may come more than once, such as again for a result that arrived after the screen closed.
   */
  release?(): void;
}

export interface IWorkspaceSymbolProviderRegistry {
  /** Fires when the last registration of a provider is disposed; a wait on that provider ends with no symbols. */
  readonly onDidRemove: Event<IWorkspaceSymbolProvider>;
  register(provider: IWorkspaceSymbolProvider): IDisposable;
  /** The registered providers, in registration order. */
  all(): readonly IWorkspaceSymbolProvider[];
  has(provider: IWorkspaceSymbolProvider): boolean;
}

class WorkspaceSymbolProviderRegistryImpl implements IWorkspaceSymbolProviderRegistry {
  private registrations: { readonly provider: IWorkspaceSymbolProvider }[] = [];
  private readonly removed = new Emitter<IWorkspaceSymbolProvider>();
  readonly onDidRemove = this.removed.event;

  register(provider: IWorkspaceSymbolProvider): IDisposable {
    const registration = { provider };
    this.registrations = [...this.registrations, registration];
    return toDisposable(() => {
      if (!this.registrations.includes(registration)) {
        return;
      }
      this.registrations = this.registrations.filter(entry => entry !== registration);
      if (!this.has(provider)) {
        this.removed.fire(provider);
      }
    });
  }

  all(): readonly IWorkspaceSymbolProvider[] {
    return [...new Set(this.registrations.map(entry => entry.provider))];
  }

  has(provider: IWorkspaceSymbolProvider): boolean {
    return this.registrations.some(entry => entry.provider === provider);
  }
}

/** The workspace symbol providers: the main thread puts the extensions' providers here. */
export const WorkspaceSymbolProviderRegistry: IWorkspaceSymbolProviderRegistry = new WorkspaceSymbolProviderRegistryImpl();

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : undefined;
}

function sanitizeRange(range: unknown): IRange | undefined {
  if (typeof range !== 'object' || range === null) {
    return undefined;
  }
  const { startLineNumber, startColumn, endLineNumber, endColumn } = range as Partial<Record<keyof IRange, unknown>>;
  const start = [positiveInteger(startLineNumber), positiveInteger(startColumn)];
  if (start[0] === undefined || start[1] === undefined) {
    return undefined;
  }
  const startLine = start[0];
  const startCol = start[1];
  let endLine = positiveInteger(endLineNumber) ?? startLine;
  let endCol = positiveInteger(endColumn) ?? startCol;
  if (endLine < startLine || (endLine === startLine && endCol < startCol)) {
    endLine = startLine;
    endCol = startCol;
  }
  return { startLineNumber: startLine, startColumn: startCol, endLineNumber: endLine, endColumn: endCol };
}

/**
 * A symbol of the expected shape, with its range clamped to 1-based positions; otherwise `undefined`.
 * Other own properties of the symbol and its location, such as what a provider needs to resolve it, are kept.
 */
export function sanitizeWorkspaceSymbol(value: unknown): IWorkspaceSymbol | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { name, containerName, kind, tags, location } = value as Partial<Record<keyof IWorkspaceSymbol, unknown>>;
  if (typeof name !== 'string' || typeof location !== 'object' || location === null) {
    return undefined;
  }
  const { uri, range } = location as { uri?: unknown; range?: unknown };
  if (!URI.isUri(uri)) {
    return undefined;
  }
  return {
    ...value,
    name,
    containerName: typeof containerName === 'string' && containerName ? containerName : undefined,
    kind: typeof kind === 'number' && Number.isInteger(kind) && kind >= 0 && kind <= 25 ? kind : 0,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is number => typeof tag === 'number') : undefined,
    location: { ...location, uri, range: sanitizeRange(range) },
  };
}

/**
 * Asks one provider. Resolves to its symbols (shape-checked), or to none at once when `token` is
 * cancelled, when the provider throws or answers something else, or when it is removed from the registry
 * while asked. It never rejects.
 */
export function askWorkspaceSymbolProvider(
  provider: IWorkspaceSymbolProvider, query: string, token: CancellationToken,
  registry: IWorkspaceSymbolProviderRegistry = WorkspaceSymbolProviderRegistry,
): Promise<IWorkspaceSymbol[]> {
  if (token.isCancellationRequested || !registry.has(provider)) {
    return Promise.resolve([]);
  }
  return new Promise(resolve => {
    const store = new DisposableStore();
    const finish = (symbols: IWorkspaceSymbol[]) => {
      store.dispose();
      resolve(symbols);
    };
    store.add(token.onCancellationRequested(() => finish([])));
    store.add(registry.onDidRemove(removed => {
      if (removed === provider) {
        finish([]);
      }
    }));
    let answer: Promise<IWorkspaceSymbol[] | undefined>;
    try {
      answer = Promise.resolve(provider.provideWorkspaceSymbols(query, token));
    } catch (error) {
      answer = Promise.reject(error);
    }
    answer.then(symbols => {
      if (token.isCancellationRequested || !Array.isArray(symbols)) {
        finish([]);
        return;
      }
      finish(symbols.map(sanitizeWorkspaceSymbol).filter((symbol): symbol is IWorkspaceSymbol => symbol !== undefined));
    }, error => {
      console.warn('A workspace symbol provider failed:', error);
      finish([]);
    });
  });
}

/** Two symbols are one when name, kind, URI and range are all equal. */
export function workspaceSymbolKey(symbol: IWorkspaceSymbol): string {
  const range = symbol.location.range;
  return JSON.stringify([
    symbol.name, symbol.kind, symbol.location.uri.toString(),
    range ? [range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn] : null,
  ]);
}

/**
 * Asks every provider and waits for all of them. Symbols equal to one an earlier provider gave are
 * left out; a provider that throws, or is removed while asked, gives none.
 */
export async function getWorkspaceSymbols(
  query: string, token: CancellationToken, registry: IWorkspaceSymbolProviderRegistry = WorkspaceSymbolProviderRegistry,
): Promise<[IWorkspaceSymbolProvider, IWorkspaceSymbol[]][]> {
  const providers = registry.all();
  const answers = await Promise.all(providers.map(provider => askWorkspaceSymbolProvider(provider, query, token, registry)));
  if (token.isCancellationRequested) {
    return [];
  }
  const seen = new Set<string>();
  const result: [IWorkspaceSymbolProvider, IWorkspaceSymbol[]][] = [];
  for (const [index, symbols] of answers.entries()) {
    const kept = symbols.filter(symbol => {
      const key = workspaceSymbolKey(symbol);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    result.push([providers[index], kept]);
  }
  return result;
}

/**
 * Resolves `symbol` through `provider` when it can resolve. Resolves to the resolved symbol
 * (shape-checked), or to `symbol` itself when the provider cannot resolve, answers nothing usable,
 * throws, is removed while asked, or `token` is cancelled. It never rejects.
 */
export function resolveWorkspaceSymbol(
  provider: IWorkspaceSymbolProvider, symbol: IWorkspaceSymbol, token: CancellationToken,
  registry: IWorkspaceSymbolProviderRegistry = WorkspaceSymbolProviderRegistry,
): Promise<IWorkspaceSymbol> {
  const resolve = provider.resolveWorkspaceSymbol;
  if (typeof resolve !== 'function' || token.isCancellationRequested || !registry.has(provider)) {
    return Promise.resolve(symbol);
  }
  return new Promise(done => {
    const store = new DisposableStore();
    const finish = (result: IWorkspaceSymbol) => {
      store.dispose();
      done(result);
    };
    store.add(token.onCancellationRequested(() => finish(symbol)));
    store.add(registry.onDidRemove(removed => {
      if (removed === provider) {
        finish(symbol);
      }
    }));
    let answer: Promise<IWorkspaceSymbol | undefined>;
    try {
      answer = Promise.resolve(resolve.call(provider, symbol, token));
    } catch (error) {
      answer = Promise.reject(error);
    }
    answer.then(resolved => {
      finish(token.isCancellationRequested ? symbol : sanitizeWorkspaceSymbol(resolved) ?? symbol);
    }, error => {
      console.warn('A workspace symbol provider failed to resolve a symbol:', error);
      finish(symbol);
    });
  });
}
