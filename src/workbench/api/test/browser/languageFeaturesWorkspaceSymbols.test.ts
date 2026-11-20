// @vitest-environment node
import type * as vscode from 'vscode';
import { afterEach, expect, test, vi } from 'vitest';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { getWorkspaceSymbols, resolveWorkspaceSymbol, WorkspaceSymbolProviderRegistry } from '../../../contrib/search/common/search.js';
import { createMainThreadWorkspaceSymbols } from '../../browser/mainThreadLanguageFeaturesWorkspaceSymbols.js';
import { Location, Range } from '../../common/extHostEditorTypes.js';
import { createWorkspaceSymbolsGroup } from '../../common/extHostLanguageFeaturesWorkspaceSymbols.js';
import type { ExtHostWorkspaceSymbols } from '../../common/extHostLanguageFeaturesWorkspaceSymbols.js';
import { SymbolInformation, SymbolKind } from '../../common/extHostLanguageFeatureTypes.js';
import { Uri } from '../../common/extHostTypes.js';
import { createLanguageFeatureTestHost, settle, workspaceUri } from './languageFeaturesTestHost.js';

/*
 * Workspace symbols: the extension host's group and the workbench's group over the real RPC, into the
 * workbench's registry that Go to Symbol in Workspace asks. Each test names the failure it catches.
 */

const notes = workspaceUri('notes.md');
const guide = workspaceUri('guide.md');

type Host = Awaited<ReturnType<typeof createLanguageFeatureTestHost>>;
let host: Host | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
  vi.restoreAllMocks();
});

async function setup() {
  host = await createLanguageFeatureTestHost({ hostGroups: [createWorkspaceSymbolsGroup], mainGroups: [createMainThreadWorkspaceSymbols] });
  const group = host.host.groups[0] as ExtHostWorkspaceSymbols;
  return { ...host, group, languages: (key = '1') => host!.api(key) };
}

const heading = (name: string, uri: URI | vscode.Uri, line: number, container = '') =>
  new SymbolInformation(name, SymbolKind.String, container, new Location(Uri.from(uri) as vscode.Uri, new Range(line, 0, line, name.length)));
type URI = import('../../../../base/common/uri.js').URI;

test('a registered provider is asked through the registry, its symbols cross with 1-based ranges, and unregistering takes it out', async () => {
  const { languages } = await setup();
  const before = WorkspaceSymbolProviderRegistry.all().length;
  const provide = vi.fn((query: string) => [heading('# Title', notes, 0), heading('## Install', guide, 4, 'Title')]
    .filter(symbol => symbol.name.toLowerCase().includes(query)));
  const registration = languages().registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: provide });
  await settle();
  expect(WorkspaceSymbolProviderRegistry.all()).toHaveLength(before + 1);
  const [[, symbols]] = (await getWorkspaceSymbols('install', CancellationToken.None)).slice(-1);
  expect(provide).toHaveBeenCalledWith('install', expect.anything());
  expect(symbols).toHaveLength(1);
  expect(symbols[0]).toMatchObject({
    name: '## Install', containerName: 'Title', kind: SymbolKind.String,
    location: { range: { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 11 } },
  });
  expect(symbols[0].location.uri.toString()).toBe(guide.toString());
  registration.dispose();
  await settle();
  expect(WorkspaceSymbolProviderRegistry.all()).toHaveLength(before);
});

test('the extension host keeps one answer per provider: a newer answer and the screen\'s release let it go; a cancelled one is never kept', async () => {
  const { languages, group } = await setup();
  const source = new CancellationTokenSource();
  let cancelOnAnswer = false;
  languages().registerWorkspaceSymbolProvider({
    provideWorkspaceSymbols: () => {
      if (cancelOnAnswer) {
        source.cancel();
      }
      return [heading('# Title', notes, 0)];
    },
  });
  await settle();
  const provider = WorkspaceSymbolProviderRegistry.all().at(-1)!;
  await provider.provideWorkspaceSymbols('', CancellationToken.None);
  expect(group.cacheSize).toBe(1);
  await provider.provideWorkspaceSymbols('t', CancellationToken.None);
  await settle();
  expect(group.cacheSize).toBe(1);
  provider.release!();
  await settle();
  expect(group.cacheSize).toBe(0);
  cancelOnAnswer = true;
  expect(await provider.provideWorkspaceSymbols('', source.token)).toBeUndefined();
  await settle();
  expect(group.cacheSize).toBe(0);
});

test('the provider\'s token is cancelled across the RPC when the screen\'s query is', async () => {
  const { languages } = await setup();
  let seen: vscode.CancellationToken | undefined;
  languages().registerWorkspaceSymbolProvider({
    provideWorkspaceSymbols: (_query, token) => {
      seen = token;
      return new Promise(() => {});
    },
  });
  await settle();
  const provider = WorkspaceSymbolProviderRegistry.all().at(-1)!;
  const source = new CancellationTokenSource();
  void provider.provideWorkspaceSymbols('slow', source.token);
  await settle();
  expect(seen?.isCancellationRequested).toBe(false);
  source.cancel();
  await settle();
  expect(seen?.isCancellationRequested).toBe(true);
});

test('a provider that resolves gets its own symbol back and the resolved range is used; one that does not cannot be asked to', async () => {
  const { languages } = await setup();
  const bare = new SymbolInformation('## Later', SymbolKind.String, '', new Location(Uri.from(notes) as vscode.Uri, new Range(0, 0, 0, 0)));
  const resolve = vi.fn((symbol: vscode.SymbolInformation) => {
    symbol.location = new Location(symbol.location.uri, new Range(9, 2, 9, 10));
    return symbol;
  });
  languages().registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: () => [bare], resolveWorkspaceSymbol: resolve });
  languages('2').registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: () => [heading('# Other', guide, 1)] });
  await settle();
  const [resolving, plain] = WorkspaceSymbolProviderRegistry.all().slice(-2);
  expect(typeof resolving.resolveWorkspaceSymbol).toBe('function');
  expect(plain.resolveWorkspaceSymbol).toBeUndefined();
  const [symbol] = (await resolving.provideWorkspaceSymbols('', CancellationToken.None))!;
  const resolved = await resolveWorkspaceSymbol(resolving, symbol, CancellationToken.None);
  expect(resolve.mock.calls[0][0]).toBe(bare);
  expect(resolved.location.range).toEqual({ startLineNumber: 10, startColumn: 3, endLineNumber: 10, endColumn: 11 });
});

test('a provider that throws gives no symbols and the others still answer; a removed extension\'s provider leaves the registry and its answers go', async () => {
  const { languages, group, features } = await setup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const before = WorkspaceSymbolProviderRegistry.all().length;
  languages().registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: () => { throw new Error('broken'); } });
  languages('2').registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: () => [heading('# Kept', guide, 0)] });
  await settle();
  const answers = await getWorkspaceSymbols('', CancellationToken.None);
  expect(answers.slice(-2).map(([, symbols]) => symbols.map(symbol => symbol.name))).toEqual([[], ['# Kept']]);
  expect(group.cacheSize).toBe(1);
  features.release('2');
  group.release('2');
  await settle();
  expect(WorkspaceSymbolProviderRegistry.all()).toHaveLength(before + 1);
  expect(group.cacheSize).toBe(0);
});

test('vscode.executeWorkspaceSymbolProvider asks every provider and gives SymbolInformation instances', async () => {
  const { languages, apiCommands } = await setup();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  languages().registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: () => [heading('# Title', notes, 0)] });
  languages('2').registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: () => [heading('## Install', guide, 3, 'Title')] });
  languages('2').registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: () => Promise.reject(new Error('skipped')) });
  await settle();
  const result = await apiCommands.execute('1', 'vscode.executeWorkspaceSymbolProvider', ['']) as vscode.SymbolInformation[];
  expect(result.map(symbol => symbol.name)).toEqual(['# Title', '## Install']);
  for (const symbol of result) {
    expect(symbol).toBeInstanceOf(SymbolInformation);
    expect(symbol.location).toBeInstanceOf(Location);
    expect(symbol.location.range).toBeInstanceOf(Range);
  }
  expect(result[1].containerName).toBe('Title');
  expect(result[1].location.range.start.line).toBe(3);
  expect(result[1].location.uri.toString()).toBe(guide.toString());
  await expect(apiCommands.execute('1', 'vscode.executeWorkspaceSymbolProvider', [42])).rejects.toThrow(TypeError);
});

test('a provider without provideWorkspaceSymbols is refused when registered', async () => {
  const { languages } = await setup();
  expect(() => languages().registerWorkspaceSymbolProvider({} as vscode.WorkspaceSymbolProvider)).toThrow(TypeError);
});
