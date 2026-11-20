import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { createWordMatcher } from '../../../../base/common/filters.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { relativePath } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import type { IQuickAccessProvider } from '../../../../platform/quickinput/common/quickAccess.js';
import type { IQuickPick, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
  askWorkspaceSymbolProvider, resolveWorkspaceSymbol, workspaceSymbolKey, WorkspaceSymbolProviderRegistry,
} from '../common/search.js';
import type { IWorkspaceSymbol, IWorkspaceSymbolProvider } from '../common/search.js';

export const SYMBOLS_PREFIX = '#';
export const SYMBOLS_PLACEHOLDER = 'Type the name of a symbol to open.';
/** The pause after typing before the providers are asked. */
export const TYPING_SEARCH_DELAY = 200;
/** The most symbol rows shown; a last row counts the rest. */
export const MAX_SYMBOL_ROWS = 10_000;
export const NO_RESULTS_LABEL = 'No matching workspace symbols';

interface SymbolEntry {
  readonly symbol: IWorkspaceSymbol;
  readonly provider: IWorkspaceSymbolProvider;
}

interface SortedRow extends SymbolEntry {
  readonly pick: IQuickPickItem;
  readonly name: string;
  readonly path: string;
}

function compareRows(a: SortedRow, b: SortedRow): number {
  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }
  if (a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  const first = a.symbol.location.range;
  const second = b.symbol.location.range;
  return (first?.startLineNumber ?? 0) - (second?.startLineNumber ?? 0)
    || (first?.startColumn ?? 0) - (second?.startColumn ?? 0);
}

/**
 * Go to Symbol in Workspace: asks every workspace symbol provider for the text after `#`, shows the
 * rows as each provider answers, and opens the chosen symbol's location.
 */
export class SymbolsQuickAccessProvider implements IQuickAccessProvider {
  static readonly PREFIX = SYMBOLS_PREFIX;

  constructor(
    @IEditorService private readonly editors: IEditorService,
    @IOpenerService private readonly opener: IOpenerService,
    @INotificationService private readonly notifications: INotificationService,
    @IFileService private readonly files: IFileService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
  ) {}

  provide(picker: IQuickPick<IQuickPickItem>, token: CancellationToken): IDisposable {
    const store = new DisposableStore();
    const entries = new WeakMap<IQuickPickItem, SymbolEntry>();
    const asked = new Set<IWorkspaceSymbolProvider>();
    let providers: readonly IWorkspaceSymbolProvider[] = [];
    let results = new Map<IWorkspaceSymbolProvider, IWorkspaceSymbol[]>();
    let pending = new Set<IWorkspaceSymbolProvider>();
    let query: CancellationTokenSource | undefined;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let opening: Promise<void> | undefined;

    const text = () => picker.value.startsWith(SYMBOLS_PREFIX) ? picker.value.slice(SYMBOLS_PREFIX.length) : picker.value;

    const render = () => {
      const filter = text();
      const match = filter.trim() ? createWordMatcher(filter) : undefined;
      const seen = new Set<string>();
      const paths = new Map<string, string>();
      const rows: SortedRow[] = [];
      for (const provider of providers) {
        for (const symbol of results.get(provider) ?? []) {
          // The quick pick filters the same way; doing it here first keeps the row cap for matching rows.
          if (match && !match(symbol.name)) {
            continue;
          }
          const key = workspaceSymbolKey(symbol);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const uri = symbol.location.uri.toString();
          let path = paths.get(uri);
          if (path === undefined) {
            path = this.pathLabel(symbol.location.uri);
            paths.set(uri, path);
          }
          const pick: IQuickPickItem = {
            label: symbol.name,
            description: symbol.containerName ? symbol.containerName + ' • ' + path : path,
          };
          rows.push({ pick, symbol, provider, name: symbol.name.toLowerCase(), path });
        }
      }
      rows.sort(compareRows);
      const items: IQuickPickItem[] = [];
      for (const row of rows.slice(0, MAX_SYMBOL_ROWS)) {
        entries.set(row.pick, row);
        items.push(row.pick);
      }
      if (rows.length > MAX_SYMBOL_ROWS) {
        const more = (rows.length - MAX_SYMBOL_ROWS).toLocaleString('en-US');
        items.push({ label: `${more} more symbols not shown; type more of the name to narrow the search`, alwaysShow: true });
      } else if (rows.length === 0 && pending.size === 0) {
        items.push({ label: NO_RESULTS_LABEL, alwaysShow: true });
      }
      picker.items = items;
      picker.busy = pending.size > 0;
    };

    const search = () => {
      timer = undefined;
      query?.cancel();
      query?.dispose();
      const source = new CancellationTokenSource(token);
      query = source;
      const id = ++generation;
      const filter = text();
      providers = WorkspaceSymbolProviderRegistry.all();
      results = new Map();
      pending = new Set(providers);
      render();
      for (const provider of providers) {
        asked.add(provider);
        void askWorkspaceSymbolProvider(provider, filter, source.token).then(symbols => {
          // A newer query, or a closed screen, takes nothing from an older one.
          if (id !== generation || token.isCancellationRequested) {
            return;
          }
          pending.delete(provider);
          results.set(provider, symbols);
          render();
        });
      }
    };

    store.add(picker.onDidChangeValue(() => {
      // The query in flight is for a value that is gone.
      generation++;
      query?.cancel();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      picker.busy = true;
      timer = setTimeout(search, TYPING_SEARCH_DELAY);
    }));

    store.add(WorkspaceSymbolProviderRegistry.onDidRemove(provider => {
      if (results.delete(provider) || pending.delete(provider)) {
        render();
      }
    }));

    store.add(picker.onDidAccept(() => {
      const [pick] = picker.selectedItems;
      const entry = pick && entries.get(pick);
      if (!entry || opening) {
        // The no-results and overflow rows choose nothing.
        return;
      }
      opening = this.openSymbol(entry);
      picker.hide();
    }));

    store.add(toDisposable(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      generation++;
      query?.cancel();
      query?.dispose();
      // What the providers keep for this screen goes once the chosen symbol has been resolved.
      const release = () => {
        for (const provider of asked) {
          try {
            provider.release?.();
          } catch (error) {
            console.warn('A workspace symbol provider failed to release its results:', error);
          }
        }
      };
      if (opening) {
        void opening.finally(release);
      } else {
        release();
      }
    }));

    search();
    return store;
  }

  /** The location relative to its workspace folder, named for that folder when there are several. */
  private pathLabel(uri: URI): string {
    const folder = this.workspace.getWorkspaceFolder(uri);
    const relative = folder && relativePath(folder.uri, uri);
    if (folder && relative) {
      return this.workspace.getWorkspace().folders.length > 1 ? folder.name + '/' + relative : relative;
    }
    return uri.toString(true);
  }

  private async openSymbol({ symbol, provider }: SymbolEntry): Promise<void> {
    const source = new CancellationTokenSource();
    let resolved: IWorkspaceSymbol;
    try {
      resolved = await resolveWorkspaceSymbol(provider, symbol, source.token);
    } finally {
      source.dispose();
    }
    const { uri, range } = resolved.location;
    try {
      if (uri.scheme === 'http' || uri.scheme === 'https') {
        await this.opener.open(uri);
        return;
      }
      // A symbol's location comes from an extension: it never runs a command or opens what no file system serves.
      if (uri.scheme === 'command' || !this.files.hasProvider(uri)) {
        this.notifications.warn(`Cannot open the symbol '${resolved.name}': its location is not a file that can be opened.`);
        return;
      }
      await this.editors.openEditor({
        resource: uri,
        options: {
          selection: range
            ? { startLineNumber: range.startLineNumber, startColumn: range.startColumn }
            : { startLineNumber: 1, startColumn: 1 },
        },
      });
    } catch (error) {
      this.notifications.error(`Cannot open the symbol '${resolved.name}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
