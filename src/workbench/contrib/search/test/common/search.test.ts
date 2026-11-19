// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import {
  askWorkspaceSymbolProvider, getWorkspaceSymbols, resolveWorkspaceSymbol, sanitizeWorkspaceSymbol,
  WorkspaceSymbolProviderRegistry,
} from '../../common/search.js';
import type { IWorkspaceSymbol, IWorkspaceSymbolProvider } from '../../common/search.js';

const disposables = new DisposableStore();
afterEach(() => {
  disposables.clear();
  vi.restoreAllMocks();
});

const file = URI.parse('wr-test:/workspace/notes.md');
function symbol(name: string, line = 1, uri = file): IWorkspaceSymbol {
  return { name, kind: 14, location: { uri, range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 5 } } };
}

function provider(answer: (query: string, token: CancellationToken) => Promise<IWorkspaceSymbol[] | undefined>): IWorkspaceSymbolProvider {
  return { provideWorkspaceSymbols: answer };
}

function register(...providers: IWorkspaceSymbolProvider[]) {
  return providers.map(entry => disposables.add(WorkspaceSymbolProviderRegistry.register(entry)));
}

test('every provider is asked with the query and the results are merged, equal symbols once', async () => {
  const first = vi.fn(async () => [symbol('## Install', 3), symbol('# Title', 1)]);
  const second = vi.fn(async () => [symbol('## Install', 3), symbol('## Install', 9), symbol('# Title', 1, URI.parse('wr-test:/workspace/other.md'))]);
  const a = provider(first);
  const b = provider(second);
  register(a, b);
  const result = await getWorkspaceSymbols('in', CancellationToken.None);
  expect(first).toHaveBeenCalledWith('in', expect.anything());
  expect(second).toHaveBeenCalledWith('in', expect.anything());
  expect(result.map(([entry, symbols]) => [entry, symbols.map(item => item.name + ':' + item.location.range!.startLineNumber)])).toEqual([
    [a, ['## Install:3', '# Title:1']],
    [b, ['## Install:9', '# Title:1']],
  ]);
});

test('a symbol with another kind or range is not the same symbol', async () => {
  const base = symbol('x', 2);
  register(provider(async () => [base, { ...base, kind: 5 }, { ...base, location: { uri: file, range: { ...base.location.range!, endColumn: 9 } } }]));
  const [[, symbols]] = await getWorkspaceSymbols('', CancellationToken.None);
  expect(symbols).toHaveLength(3);
});

test('a provider that throws, rejects or answers nonsense is skipped and the others still answer', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const good = provider(async () => [symbol('Good')]);
  register(
    provider(() => { throw new Error('sync'); }),
    provider(async () => { throw new Error('async'); }),
    provider(async () => 'nonsense' as never),
    provider(async () => [{ name: 3 } as never, symbol('Kept')]),
    good,
  );
  const result = await getWorkspaceSymbols('', CancellationToken.None);
  expect(result.flatMap(([, symbols]) => symbols.map(item => item.name))).toEqual(['Kept', 'Good']);
});

test('a provider removed while asked ends its wait with nothing', async () => {
  const [registration] = register(provider(() => new Promise(() => {})));
  const answer = askWorkspaceSymbolProvider(WorkspaceSymbolProviderRegistry.all()[0], 'q', CancellationToken.None);
  registration.dispose();
  await expect(answer).resolves.toEqual([]);
  expect(WorkspaceSymbolProviderRegistry.all()).toEqual([]);
});

test('cancellation ends the wait at once and drops a later answer', async () => {
  let finish!: (symbols: IWorkspaceSymbol[]) => void;
  let seen: CancellationToken | undefined;
  const slow = provider((_query, token) => { seen = token; return new Promise(resolve => { finish = resolve; }); });
  register(slow);
  const source = new CancellationTokenSource();
  const answer = askWorkspaceSymbolProvider(slow, 'q', source.token);
  source.cancel();
  expect(seen?.isCancellationRequested).toBe(true);
  await expect(answer).resolves.toEqual([]);
  finish([symbol('Late')]);

  const all = new CancellationTokenSource();
  const merged = getWorkspaceSymbols('q', all.token);
  all.cancel();
  await expect(merged).resolves.toEqual([]);
});

test('registering one provider twice lists it once and removes it with its last registration', async () => {
  const entry = provider(async () => [symbol('Once')]);
  const [first, second] = register(entry, entry);
  expect(WorkspaceSymbolProviderRegistry.all()).toEqual([entry]);
  const removed = vi.fn();
  disposables.add(WorkspaceSymbolProviderRegistry.onDidRemove(removed));
  first.dispose();
  expect(removed).not.toHaveBeenCalled();
  second.dispose();
  expect(removed).toHaveBeenCalledWith(entry);
  expect(WorkspaceSymbolProviderRegistry.all()).toEqual([]);
});

test('a symbol is shape-checked: its range is clamped to 1-based positions and other properties stay', () => {
  const uri = URI.parse('wr-test:/a.md');
  expect(sanitizeWorkspaceSymbol({
    name: 'n', kind: 99, cacheId: [1, 2], location: { uri, range: { startLineNumber: 0, startColumn: -3, endLineNumber: 0, endColumn: 0 } },
  })).toEqual({
    name: 'n', kind: 0, cacheId: [1, 2], containerName: undefined, tags: undefined,
    location: { uri, range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } },
  });
  expect(sanitizeWorkspaceSymbol({ name: 'n', kind: 1, location: { uri } })?.location.range).toBeUndefined();
  expect(sanitizeWorkspaceSymbol({ name: 'n', kind: 1, location: { uri: 'wr-test:/a.md' } })).toBeUndefined();
});

test('resolving uses the provider when it can and falls back to the symbol', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const unresolved: IWorkspaceSymbol = { name: 'n', kind: 1, location: { uri: file } };
  const resolving: IWorkspaceSymbolProvider = {
    provideWorkspaceSymbols: async () => [],
    resolveWorkspaceSymbol: async item => ({ ...item, location: { uri: item.location.uri, range: symbol('n', 4).location.range } }),
  };
  const throwing: IWorkspaceSymbolProvider = { provideWorkspaceSymbols: async () => [], resolveWorkspaceSymbol: async () => { throw new Error('no'); } };
  const plain = provider(async () => []);
  register(resolving, throwing, plain);
  expect((await resolveWorkspaceSymbol(resolving, unresolved, CancellationToken.None)).location.range?.startLineNumber).toBe(4);
  await expect(resolveWorkspaceSymbol(throwing, unresolved, CancellationToken.None)).resolves.toBe(unresolved);
  await expect(resolveWorkspaceSymbol(plain, unresolved, CancellationToken.None)).resolves.toBe(unresolved);
});
