import { CancellationToken } from '../../../base/common/cancellation.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { getWorkspaceSymbols, sanitizeWorkspaceSymbol, WorkspaceSymbolProviderRegistry } from '../../contrib/search/common/search.js';
import type { IWorkspaceSymbol, IWorkspaceSymbolProvider, IWorkspaceSymbolProviderRegistry } from '../../contrib/search/common/search.js';
import type { MainThreadWorkspaceSymbolsShape, WorkspaceSymbolDto, WorkspaceSymbolListDto } from '../common/extHost.protocol.languageFeatures.js';
import type { MainThreadLanguageFeatures } from './mainThreadLanguageFeatures.js';

/*
 * Workspace symbols on the workbench side (wr-c9d8.qq0). Monaco's standalone editor has no workspace
 * symbols, so an extension's provider goes into the workbench's registry, which Go to Symbol in
 * Workspace (`contrib/search/browser/symbolsQuickAccess.ts`) and `vscode.executeWorkspaceSymbolProvider`
 * ask. It does not wait for Monaco: the screen opens without an editor.
 *
 * The extension host keeps each answer for resolving. The workbench lets go of a provider's answer when
 * a newer one arrives, when the screen calls `release` (it closed) and when the provider goes; an answer
 * that arrives cancelled is let go at once.
 */

/** The symbol a provider gave, with what the extension host needs to resolve it. */
interface ProviderSymbol extends IWorkspaceSymbol {
  readonly cacheId?: readonly [number, number];
}

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function checkCacheId(value: unknown): readonly [number, number] | undefined {
  return Array.isArray(value) && value.length === 2 && isId(value[0]) && Number.isSafeInteger(value[1]) && value[1] >= 0
    ? [value[0], value[1]] : undefined;
}

/** A symbol of the extension host's answer, checked as every provider's symbol is; another shape is dropped. */
function toSymbol(dto: unknown): ProviderSymbol | undefined {
  const symbol = sanitizeWorkspaceSymbol(dto);
  if (!symbol) {
    return undefined;
  }
  const { name, containerName, kind, tags, location } = symbol;
  return {
    name, containerName, kind, tags, location: { uri: location.uri, range: location.range },
    cacheId: checkCacheId((dto as { cacheId?: unknown }).cacheId),
  };
}

/** A workbench symbol as it crosses to the extension host: plain values. */
function toDto(symbol: IWorkspaceSymbol): WorkspaceSymbolDto {
  return {
    name: symbol.name, containerName: symbol.containerName, kind: symbol.kind, tags: symbol.tags ? [...symbol.tags] : undefined,
    location: { uri: symbol.location.uri, range: symbol.location.range }, cacheId: (symbol as ProviderSymbol).cacheId,
  };
}

/** The most symbols `vscode.executeWorkspaceSymbolProvider` gives back. */
const MAX_EXECUTE_SYMBOLS = 10_000;

export class MainThreadWorkspaceSymbols implements MainThreadWorkspaceSymbolsShape, IDisposable {
  constructor(
    private readonly seam: MainThreadLanguageFeatures,
    private readonly registry: IWorkspaceSymbolProviderRegistry = WorkspaceSymbolProviderRegistry,
  ) {
    liveGroups.add(this);
  }

  /** How many answers the extension host keeps now. */
  cacheSize(): Promise<number> {
    return this.seam.proxy.$workspaceSymbolCacheSize();
  }

  dispose(): void {
    liveGroups.delete(this);
  }

  $registerNavigateTypeSupport(extension: string, handle: number, supportsResolve: unknown): Promise<void> {
    return this.seam.registerInWorkbench(extension, handle, () => {
      const { provider, dispose } = this.provider(handle, supportsResolve === true);
      const registration = this.registry.register(provider);
      return toDisposable(() => {
        registration.dispose();
        dispose();
      });
    });
  }

  /** The registry's provider for `handle`, and what lets go of it when the registration goes. */
  private provider(handle: number, supportsResolve: boolean): { provider: IWorkspaceSymbolProvider; dispose(): void } {
    const { proxy } = this.seam;
    let last: number | undefined;
    let gone = false;
    const release = (id: number | undefined) => {
      if (id !== undefined) {
        void proxy.$releaseWorkspaceSymbols(handle, id).catch(() => {});
      }
    };
    const provider: IWorkspaceSymbolProvider = {
      provideWorkspaceSymbols: async (search, token) => {
        const dto: WorkspaceSymbolListDto | undefined = await proxy.$provideWorkspaceSymbols(handle, search, token);
        const id = dto && isId(dto.id) ? dto.id : undefined;
        if (token.isCancellationRequested || gone) {
          // Nobody shows it.
          release(id);
          return undefined;
        }
        // As VS Code: a provider's newer answer replaces its older one.
        release(last);
        last = id;
        if (!dto || !Array.isArray(dto.symbols)) {
          return undefined;
        }
        return dto.symbols.map(toSymbol).filter((symbol): symbol is ProviderSymbol => !!symbol);
      },
      release: () => {
        release(last);
        last = undefined;
      },
    };
    if (supportsResolve) {
      provider.resolveWorkspaceSymbol = async (symbol, token) => {
        if (!(symbol as ProviderSymbol).cacheId) {
          return undefined;
        }
        return toSymbol(await proxy.$resolveWorkspaceSymbol(handle, toDto(symbol), token));
      };
    }
    return {
      provider,
      dispose: () => {
        gone = true;
        // The extension host keeps the provider's last answer until it is let go.
        provider.release?.();
      },
    };
  }

  /** `vscode.executeWorkspaceSymbolProvider`: every provider of every extension host, as the screen asks them. */
  async $executeWorkspaceSymbolProvider(query: unknown): Promise<WorkspaceSymbolDto[]> {
    if (typeof query !== 'string') {
      throw new TypeError('Expected a query string.');
    }
    const answers = await getWorkspaceSymbols(query, CancellationToken.None, this.registry);
    return answers.flatMap(([, symbols]) => symbols).slice(0, MAX_EXECUTE_SYMBOLS).map(toDto);
  }
}

/** The workspace symbol groups of the hosts alive now. */
const liveGroups = new Set<MainThreadWorkspaceSymbols>();

/**
 * How many workspace symbol answers the extension hosts keep now, for tests that look for leaks: the
 * answers of a closed screen are gone. Not in the command palette.
 */
CommandsRegistry.registerCommand('_workbench.languageFeatures.workspaceSymbolCacheSize', async () => {
  const sizes = await Promise.all([...liveGroups].map(group => group.cacheSize().catch(() => 0)));
  return sizes.reduce((sum, size) => sum + size, 0);
});

/** The group's factory; a function declaration, so the seam can list it while the two modules load each other. */
export function createMainThreadWorkspaceSymbols(seam: MainThreadLanguageFeatures): MainThreadWorkspaceSymbols {
  return new MainThreadWorkspaceSymbols(seam);
}
