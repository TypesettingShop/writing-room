import type * as vscode from 'vscode';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { ExtHostWorkspaceSymbolsShape, WorkspaceSymbolDto, WorkspaceSymbolListDto } from './extHost.protocol.languageFeatures.js';
import { Location, Range } from './extHostEditorTypes.js';
import { isRange } from './extHostLanguageConverters.js';
import type { ExtHostLanguageFeatures, LanguageFeatureGroup } from './extHostLanguageFeatures.js';
import { SymbolInformation } from './extHostLanguageFeatureTypes.js';
import { rangeFromEditor, rangeToEditor } from './extHostTypeConverters.js';
import type { EditorRange } from './extHostTypeConverters.js';

/*
 * Workspace symbols on the extension host (wr-c9d8.qq0): `languages.registerWorkspaceSymbolProvider`,
 * the `$` methods the workbench's registry (`contrib/search/common/search.ts`) asks through, and the API
 * command `vscode.executeWorkspaceSymbolProvider`.
 *
 * The symbols of one answer stay on the extension host under the answer's id, so that resolving finds
 * the provider's own object; the workbench releases an answer when a newer one of the same provider
 * arrives and when the screen closes. An answer to a request that was cancelled is never kept.
 */

class NavigateTypeAdapter {
  constructor(readonly provider: vscode.WorkspaceSymbolProvider) {}
}

interface CachedSymbols {
  readonly handle: number;
  readonly extension: HostExtensionDescription;
  readonly symbols: vscode.SymbolInformation[];
}

/** Symbols of one answer that cross; more are dropped (the screen shows 10,000 rows of all providers). */
const MAX_SYMBOLS = 10_000;
const MAX_TEXT = 10 * 1024;

const text = (value: unknown): string | undefined => typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined;
const isKind = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 25;

/** A provider's symbol as it crosses; one without a name or a location's Uri is dropped. */
function symbolToDto(symbol: vscode.SymbolInformation, id: number, index: number): WorkspaceSymbolDto | undefined {
  const name = text(symbol?.name);
  const location = symbol?.location;
  if (!name || !location || !URI.isUri(location.uri)) {
    return undefined;
  }
  return {
    name,
    containerName: text(symbol.containerName) || undefined,
    kind: isKind(symbol.kind) ? symbol.kind : 0,
    tags: Array.isArray(symbol.tags) ? symbol.tags.filter(tag => tag === 1) : undefined,
    location: { uri: location.uri as unknown as URI, range: isRange(location.range) ? rangeToEditor(location.range) : undefined },
    cacheId: [id, index],
  };
}

/** A workbench symbol as the API gives it: a `SymbolInformation` with a `Location`. */
export function symbolFromDto(dto: WorkspaceSymbolDto): vscode.SymbolInformation {
  const range = dto.location.range ? rangeFromEditor(dto.location.range as EditorRange) : new Range(0, 0, 0, 0);
  return new SymbolInformation(dto.name, dto.kind as vscode.SymbolKind, dto.containerName ?? '',
    new Location(dto.location.uri as unknown as vscode.Uri, range));
}

export class ExtHostWorkspaceSymbols implements ExtHostWorkspaceSymbolsShape, LanguageFeatureGroup {
  private readonly lists = new Map<number, CachedSymbols>();
  private nextList = 0;
  private readonly apiCommand: vscode.Disposable;

  constructor(private readonly features: ExtHostLanguageFeatures) {
    this.apiCommand = features.commands.registerApiCommand('vscode.executeWorkspaceSymbolProvider', async (_extension, args) => {
      const query = args[0];
      if (typeof query !== 'string') {
        throw new TypeError('vscode.executeWorkspaceSymbolProvider expects a query string.');
      }
      const symbols = await features.proxy.$executeWorkspaceSymbolProvider(query);
      return Array.isArray(symbols) ? symbols.map(symbolFromDto) : [];
    });
  }

  /** The answers kept now, for tests that look for leaks. */
  get cacheSize(): number {
    return this.lists.size;
  }

  api(extension: HostExtensionDescription) {
    const { features } = this;
    return {
      registerWorkspaceSymbolProvider: (provider: vscode.WorkspaceSymbolProvider) => {
        if (!provider || typeof provider.provideWorkspaceSymbols !== 'function') {
          throw new TypeError("The provider has no 'provideWorkspaceSymbols' function.");
        }
        const supportsResolve = typeof provider.resolveWorkspaceSymbol === 'function';
        return features.register(extension, new NavigateTypeAdapter(provider), handle =>
          features.proxy.$registerNavigateTypeSupport(extension.key, handle, supportsResolve));
      },
    } satisfies Pick<typeof vscode.languages, 'registerWorkspaceSymbolProvider'>;
  }

  async $provideWorkspaceSymbols(handle: number, query: string, token: CancellationToken): Promise<WorkspaceSymbolListDto | undefined> {
    let built: { list: CachedSymbols; dto: WorkspaceSymbolListDto } | undefined;
    const result = await this.features.invoke(handle, NavigateTypeAdapter, token, undefined, async (adapter, extension) => {
      if (typeof query !== 'string') {
        return undefined;
      }
      const value = await adapter.provider.provideWorkspaceSymbols(query, token as vscode.CancellationToken);
      if (!Array.isArray(value) || token.isCancellationRequested) {
        return undefined;
      }
      const symbols = value.slice(0, MAX_SYMBOLS);
      const id = ++this.nextList;
      const dtos: WorkspaceSymbolDto[] = [];
      symbols.forEach((symbol, index) => {
        const dto = symbolToDto(symbol, id, index);
        if (dto) {
          dtos.push(dto);
        }
      });
      built = { list: { handle, extension, symbols }, dto: { id, symbols: dtos } };
      return built.dto;
    });
    if (!result || !built || built.dto !== result || token.isCancellationRequested) {
      return undefined;
    }
    this.lists.set(result.id, built.list);
    return result;
  }

  async $resolveWorkspaceSymbol(handle: number, symbol: WorkspaceSymbolDto, token: CancellationToken): Promise<WorkspaceSymbolDto | undefined> {
    const [id, index] = Array.isArray(symbol?.cacheId) ? symbol.cacheId : [];
    const list = typeof id === 'number' ? this.lists.get(id) : undefined;
    const item = list?.handle === handle && Number.isSafeInteger(index) ? list.symbols[index as number] : undefined;
    if (!list || !item) {
      return undefined;
    }
    return this.features.invoke(handle, NavigateTypeAdapter, token, undefined, async adapter => {
      if (typeof adapter.provider.resolveWorkspaceSymbol !== 'function') {
        return undefined;
      }
      const resolved = await adapter.provider.resolveWorkspaceSymbol(item, token as vscode.CancellationToken);
      if (!resolved || token.isCancellationRequested || this.lists.get(id as number) !== list) {
        return undefined;
      }
      list.symbols[index as number] = resolved;
      return symbolToDto(resolved, id as number, index as number);
    });
  }

  async $releaseWorkspaceSymbols(handle: number, id: number): Promise<void> {
    if (this.lists.get(id)?.handle === handle) {
      this.lists.delete(id);
    }
  }

  async $workspaceSymbolCacheSize(): Promise<number> {
    return this.lists.size;
  }

  /** Forgets the answers of an extension that was released. */
  release(key: string): void {
    for (const [id, list] of [...this.lists]) {
      if (list.extension.key === key) {
        this.lists.delete(id);
      }
    }
  }

  dispose(): void {
    this.lists.clear();
    this.apiCommand.dispose();
  }
}

/** The group's factory; a function declaration, so the seam can list it while the two modules load each other. */
export function createWorkspaceSymbolsGroup(features: ExtHostLanguageFeatures): ExtHostWorkspaceSymbols {
  return new ExtHostWorkspaceSymbols(features);
}
