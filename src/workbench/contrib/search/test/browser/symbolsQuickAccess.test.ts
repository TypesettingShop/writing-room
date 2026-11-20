import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { BrowserLayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { QuickAccessController } from '../../../../../platform/quickinput/browser/quickAccess.js';
import { QuickInputService } from '../../../../../platform/quickinput/browser/quickInputService.js';
import { QuickAccessRegistry } from '../../../../../platform/quickinput/common/quickAccess.js';
import type { IQuickPick, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import type { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';
import {
  MAX_SYMBOL_ROWS, NO_RESULTS_LABEL, SYMBOLS_PLACEHOLDER, SYMBOLS_PREFIX, SymbolsQuickAccessProvider, TYPING_SEARCH_DELAY,
} from '../../browser/symbolsQuickAccess.js';
import { WorkspaceSymbolProviderRegistry } from '../../common/search.js';
import type { IWorkspaceSymbol, IWorkspaceSymbolProvider } from '../../common/search.js';

const root = URI.parse('wr-workspace:/project');
const folder: IWorkspaceFolder = { uri: root, name: 'project', index: 0, toResource: path => URI.joinPath(root, path) };
const workspace: IWorkspaceContextService = {
  _serviceBrand: undefined,
  onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  getWorkbenchState: () => WorkbenchState.FOLDER,
  getWorkspace: () => ({ id: 'test', folders: [folder] }),
  getWorkspaceFolder: resource => resource.path.startsWith('/project/') ? folder : null,
};

const disposables = new DisposableStore();
let service: QuickInputService;
let controller: QuickAccessController;
let previous: HTMLTextAreaElement;
let openEditor: ReturnType<typeof vi.fn>;
let openLink: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.fn>;
let error: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  service = new QuickInputService(new BrowserLayoutService());
  openEditor = vi.fn(async () => {
    // As the editor service does, the opened editor takes focus.
    editorElement.focus();
    return undefined;
  });
  openLink = vi.fn(async () => true);
  warn = vi.fn();
  error = vi.fn();
  const provider = new SymbolsQuickAccessProvider(
    { openEditor } as unknown as IEditorService,
    { open: openLink } as unknown as IOpenerService,
    { warn, error } as unknown as INotificationService,
    { hasProvider: (uri: URI) => uri.scheme === 'wr-workspace' } as unknown as IFileService,
    workspace,
  );
  const registry = new QuickAccessRegistry();
  registry.registerQuickAccessProvider({
    ctor: SymbolsQuickAccessProvider, prefix: SYMBOLS_PREFIX, placeholder: SYMBOLS_PLACEHOLDER,
    helpEntries: [{ description: 'Go to Symbol in Workspace' }],
  });
  controller = new QuickAccessController(service, { createInstance: () => provider } as never, registry);
  previous = document.createElement('textarea');
  editorElement = document.createElement('textarea');
  document.body.append(previous, editorElement);
  previous.focus();
});

let editorElement: HTMLTextAreaElement;

afterEach(() => {
  service.dispose();
  disposables.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function symbol(name: string, path: string, line = 1, column = 1, containerName?: string): IWorkspaceSymbol {
  return {
    name, containerName, kind: 14,
    location: { uri: URI.joinPath(root, path), range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column + 3 } },
  };
}

interface Call {
  readonly query: string;
  readonly token: CancellationToken;
  answer(symbols: IWorkspaceSymbol[] | undefined): void;
  fail(reason: unknown): void;
}

/** A provider whose every call waits until the test answers it. */
function manualProvider(extra: Partial<IWorkspaceSymbolProvider> = {}) {
  const calls: Call[] = [];
  const provider: IWorkspaceSymbolProvider = {
    provideWorkspaceSymbols: (query, token) => new Promise((resolve, reject) => {
      calls.push({ query, token, answer: resolve, fail: reject });
    }),
    release: vi.fn(),
    ...extra,
  };
  const registration = disposables.add(WorkspaceSymbolProviderRegistry.register(provider));
  return { provider, calls, registration };
}

/** A provider that answers at once, filtering loosely by the first letter. */
function instantProvider(symbols: IWorkspaceSymbol[], extra: Partial<IWorkspaceSymbolProvider> = {}) {
  const queries: string[] = [];
  const provider: IWorkspaceSymbolProvider = {
    provideWorkspaceSymbols: async query => {
      queries.push(query);
      return symbols.filter(item => !query || item.name.toLowerCase().includes(query[0].toLowerCase()));
    },
    release: vi.fn(),
    ...extra,
  };
  const registration = disposables.add(WorkspaceSymbolProviderRegistry.register(provider));
  return { provider, queries, registration };
}

const field = () => document.querySelector<HTMLInputElement>('.wr-quick-input input');
const options = () => [...document.querySelectorAll('[role=option]')];
const labels = () => options().map(row => row.querySelector('.wr-quick-input-label')!.textContent);
const descriptions = () => options().map(row => row.querySelector('.wr-quick-input-description')!.textContent);
const busy = () => !document.querySelector<HTMLElement>('.wr-quick-input-progress')!.hidden;

function type(value: string): void {
  field()!.value = value;
  field()!.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(key: string): void {
  field()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

const settle = () => vi.advanceTimersByTimeAsync(0);

test('opening asks every provider for an empty query and shows sorted rows with container and relative path', async () => {
  const { queries } = instantProvider([
    symbol('beta', 'b.md', 2), symbol('Alpha', 'z.md', 9), symbol('alpha', 'a.md', 7, 1, 'Intro'), symbol('alpha', 'a.md', 3),
  ]);
  controller.show('#');
  expect(field()!.placeholder).toBe(SYMBOLS_PLACEHOLDER);
  await settle();
  expect(queries).toEqual(['']);
  expect(labels()).toEqual(['alpha', 'alpha', 'Alpha', 'beta']);
  expect(descriptions()).toEqual(['a.md', 'Intro • a.md', 'z.md', 'b.md']);
});

test('typing asks the providers once, 200 ms after the last key, with the text after one #', async () => {
  const { queries } = instantProvider([symbol('# Title', 'a.md'), symbol('## Install', 'a.md', 3)]);
  controller.show('#');
  await settle();
  type('#i');
  type('#in');
  await vi.advanceTimersByTimeAsync(TYPING_SEARCH_DELAY - 1);
  type('#ins');
  await vi.advanceTimersByTimeAsync(TYPING_SEARCH_DELAY - 1);
  expect(queries).toEqual(['']);
  await vi.advanceTimersByTimeAsync(1);
  expect(queries).toEqual(['', 'ins']);
  expect(labels()).toEqual(['## Install']);

  type('##');
  await vi.advanceTimersByTimeAsync(TYPING_SEARCH_DELAY);
  expect(queries.at(-1)).toBe('#');
  expect(labels()).toEqual(['# Title', '## Install']);
});

test('only rows whose name holds the text are kept, whatever the provider sent', async () => {
  instantProvider([symbol('alpha', 'a.md'), symbol('almond', 'a.md'), symbol('banana', 'a.md')]);
  controller.show('#');
  type('#lp');
  await vi.advanceTimersByTimeAsync(TYPING_SEARCH_DELAY);
  expect(labels()).toEqual(['alpha']);
});

test('a new query cancels the old one, and the old answer never reaches the list', async () => {
  const { calls } = manualProvider();
  controller.show('#');
  expect(calls.map(call => call.query)).toEqual(['']);
  type('#a');
  expect(calls[0].token.isCancellationRequested).toBe(true);
  // The cancelled query's empty answer does not end the wait for the next one.
  await settle();
  expect(busy()).toBe(true);
  expect(labels()).toEqual([]);
  await vi.advanceTimersByTimeAsync(TYPING_SEARCH_DELAY);
  type('#ab');
  expect(calls[1].token.isCancellationRequested).toBe(true);
  await vi.advanceTimersByTimeAsync(TYPING_SEARCH_DELAY);
  expect(calls.map(call => call.query)).toEqual(['', 'a', 'ab']);
  calls[2].answer([symbol('abc', 'new.md')]);
  await settle();
  calls[1].answer([symbol('abacus', 'old.md')]);
  calls[0].answer([symbol('about', 'old.md')]);
  await settle();
  expect(labels()).toEqual(['abc']);
  expect(busy()).toBe(false);
});

test('a throwing or silent provider does not keep the other rows away, and a row can still be chosen', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const silent = manualProvider();
  const throwing = manualProvider();
  instantProvider([symbol('Ready', 'a.md', 5, 3)]);
  controller.show('#');
  await settle();
  throwing.calls[0].fail(new Error('boom'));
  await settle();
  expect(labels()).toEqual(['Ready']);
  expect(busy()).toBe(true);
  expect(silent.calls).toHaveLength(1);
  press('Enter');
  await settle();
  expect(field()).toBeNull();
  expect(openEditor).toHaveBeenCalledWith({
    resource: URI.joinPath(root, 'a.md'), options: { selection: { startLineNumber: 5, startColumn: 3 } },
  });
  expect(document.activeElement).toBe(editorElement);
  expect(silent.calls[0].token.isCancellationRequested).toBe(true);
});

test('with no provider, or no match, one row says so and choosing it does nothing', async () => {
  controller.show('#');
  await settle();
  expect(labels()).toEqual([NO_RESULTS_LABEL]);
  expect(busy()).toBe(false);
  press('Enter');
  await settle();
  expect(field()).not.toBeNull();
  options()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();
  expect(field()).not.toBeNull();
  expect(openEditor).not.toHaveBeenCalled();
  press('Escape');

  const { calls } = manualProvider();
  controller.show('#zz');
  await settle();
  // While a provider is still answering, the list is not yet called empty.
  expect(labels()).toEqual([]);
  calls[0].answer([symbol('alpha', 'a.md')]);
  await settle();
  expect(labels()).toEqual([NO_RESULTS_LABEL]);
  // The row shows whatever the filter is.
  type('#zzz');
  expect(labels()).toEqual([NO_RESULTS_LABEL]);
});

test('Escape cancels the query and releases every provider that was asked', async () => {
  const { calls, provider } = manualProvider();
  const instant = instantProvider([symbol('x', 'a.md')]);
  controller.show('#');
  await settle();
  expect(provider.release).not.toHaveBeenCalled();
  press('Escape');
  expect(calls[0].token.isCancellationRequested).toBe(true);
  expect(provider.release).toHaveBeenCalledTimes(1);
  expect(instant.provider.release).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(previous);
  calls[0].answer([symbol('late', 'a.md')]);
  await settle();
  expect(field()).toBeNull();
});

test('choosing a row resolves it first when the provider resolves, then releases', async () => {
  let finish!: (symbol: IWorkspaceSymbol) => void;
  const order: string[] = [];
  const unresolved: IWorkspaceSymbol = { name: 'Lazy', kind: 11, location: { uri: URI.joinPath(root, 'lazy.md') } };
  const { provider } = instantProvider([unresolved], {
    resolveWorkspaceSymbol: item => new Promise(resolve => {
      order.push('resolve');
      finish = resolved => { order.push('resolved'); resolve(resolved); };
      void item;
    }),
    release: () => { order.push('release'); },
  });
  void provider;
  controller.show('#');
  await settle();
  press('Enter');
  expect(field()).toBeNull();
  await settle();
  expect(order).toEqual(['resolve']);
  finish({ ...unresolved, location: { uri: unresolved.location.uri, range: { startLineNumber: 12, startColumn: 4, endLineNumber: 12, endColumn: 8 } } });
  await settle();
  expect(order).toEqual(['resolve', 'resolved', 'release']);
  expect(openEditor).toHaveBeenCalledWith({
    resource: URI.joinPath(root, 'lazy.md'), options: { selection: { startLineNumber: 12, startColumn: 4 } },
  });
});

test('a location without a range, even after resolving, opens at the start of the file', async () => {
  const unresolved: IWorkspaceSymbol = { name: 'Lazy', kind: 11, location: { uri: URI.joinPath(root, 'lazy.md') } };
  instantProvider([unresolved], { resolveWorkspaceSymbol: async () => undefined });
  controller.show('#');
  await settle();
  press('Enter');
  await settle();
  expect(openEditor).toHaveBeenCalledWith({
    resource: URI.joinPath(root, 'lazy.md'), options: { selection: { startLineNumber: 1, startColumn: 1 } },
  });
});

test('a command location, or one no file system serves, is refused with a notification; web links go to the opener', async () => {
  const command: IWorkspaceSymbol = { name: 'Run', kind: 11, location: { uri: URI.parse('command:workbench.action.closeWindow') } };
  const unknown: IWorkspaceSymbol = { name: 'Elsewhere', kind: 11, location: { uri: URI.parse('ftp://host/file.md') } };
  const web: IWorkspaceSymbol = { name: 'Web', kind: 11, location: { uri: URI.parse('https://example.com/page') } };
  instantProvider([command, unknown, web]);
  for (const name of ['Run', 'Elsewhere', 'Web']) {
    controller.show('#');
    await settle();
    const index = labels().indexOf(name);
    for (let step = 0; step < index; step++) {
      press('ArrowDown');
    }
    press('Enter');
    await settle();
  }
  expect(openEditor).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls.map(call => call[0])).toEqual([
    expect.stringContaining("'Run'"), expect.stringContaining("'Elsewhere'"),
  ]);
  expect(openLink).toHaveBeenCalledTimes(1);
  expect(openLink).toHaveBeenCalledWith(URI.parse('https://example.com/page'));
});

test('a provider removed while asked ends its wait, and a removed provider\'s rows go', async () => {
  const silent = manualProvider();
  const answered = instantProvider([symbol('Gone', 'a.md')]);
  controller.show('#');
  await settle();
  expect(busy()).toBe(true);
  silent.registration.dispose();
  await settle();
  expect(busy()).toBe(false);
  expect(labels()).toEqual(['Gone']);
  answered.registration.dispose();
  await settle();
  expect(labels()).toEqual([NO_RESULTS_LABEL]);
});

test('more than 10,000 rows shows the first 10,000 and counts the rest on a last row', async () => {
  const many = Array.from({ length: MAX_SYMBOL_ROWS + 1234 }, (_, index) => symbol('sym' + String(index).padStart(5, '0'), 'a.md'));
  instantProvider(many);
  const created = vi.spyOn(service, 'createQuickPick');
  controller.show('#');
  await settle();
  const picker = created.mock.results[0].value as IQuickPick<IQuickPickItem>;
  expect(picker.items).toHaveLength(MAX_SYMBOL_ROWS + 1);
  expect(picker.items[MAX_SYMBOL_ROWS - 1].label).toBe('sym09999');
  expect(picker.items.at(-1)?.label).toBe('1,234 more symbols not shown; type more of the name to narrow the search');
  // The list draws rows as they come into reach.
  expect(options()[0].getAttribute('aria-setsize')).toBe(String(MAX_SYMBOL_ROWS + 1));
  expect(options().length).toBeLessThan(1000);
}, 20_000);

test('names, containers and paths are drawn as text', async () => {
  instantProvider([symbol('<img src=x onerror=alert(1)>', '<b>a</b>.md', 1, 1, '<i>c</i>')]);
  controller.show('#');
  await settle();
  expect(document.querySelector('.wr-quick-input img, .wr-quick-input b, .wr-quick-input i')).toBeNull();
  expect(labels()).toEqual(['<img src=x onerror=alert(1)>']);
  expect(descriptions()[0]).toBe('<i>c</i> • <b>a</b>.md');
});

test('deleting # ends the screen, and typing # again asks each provider once', async () => {
  const { queries } = instantProvider([symbol('alpha', 'a.md')]);
  controller.show('#');
  await settle();
  type('');
  expect(labels()).toEqual(['#']);
  await vi.advanceTimersByTimeAsync(TYPING_SEARCH_DELAY * 2);
  expect(queries).toEqual(['']);
  type('#');
  await vi.advanceTimersByTimeAsync(TYPING_SEARCH_DELAY * 2);
  expect(queries).toEqual(['', '']);
  expect(labels()).toEqual(['alpha']);
});
