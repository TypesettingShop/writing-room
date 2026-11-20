import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { URI } from '../../../base/common/uri.js';
import { score } from '../../../editor/common/languageSelector.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { RPCProtocol } from '../../services/extensions/common/rpcProtocol.js';
import { MainThreadBulkEditsProxy } from './extHost.protocol.documents.js';
import type { MainThreadBulkEditsShape } from './extHost.protocol.documents.js';
import { ExtHostLanguageFeaturesProxy, MainThreadLanguageFeaturesProxy, mergeHandlers } from './extHost.protocol.languageFeatures.js';
import type {
  CommandDto, ExtHostLanguageFeaturesSeamShape, LanguageSelectorDto, MainThreadLanguageFeaturesShape,
} from './extHost.protocol.languageFeatures.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';
import type { ExtHostCommands } from './extHostCommands.js';
import type { ExtHostDocuments } from './extHostDocuments.js';
import { languageConfigurationToDto, selectorFromDto, selectorToDto } from './extHostLanguageConverters.js';
import { Disposable } from './extHostTypes.js';
import { setLanguageWordPattern } from './extHostLanguageWordPatterns.js';
import { createCompletionsGroup } from './extHostLanguageFeaturesCompletions.js';
import { createEditsGroup } from './extHostLanguageFeaturesEdits.js';
import { createNavigationGroup } from './extHostLanguageFeaturesNavigation.js';
import { createWorkspaceSymbolsGroup } from './extHostLanguageFeaturesWorkspaceSymbols.js';
import { createReceiveOnlyGroup } from './extHostLanguageFeaturesReceiveOnly.js';

/*
 * The seam every language feature provider goes through.
 *
 * - Registering: a provider gets a handle and an adapter, which turns the workbench's calls into
 *   provider calls and the results into what crosses back. The workbench is told with a
 *   `$register*` call of the feature; disposing the registration, or the extension's release, takes it
 *   back with `$unregister`.
 * - Calling: `invoke` finds the adapter by handle and kind, and the document by URI in the host's own
 *   copy. A document the extension may not read, a handle that is gone, a cancelled token or a provider
 *   that throws gives the fallback; a throw is logged with the extension's public identifier. A
 *   cancellation answers at once with the fallback even while the provider still runs; an adapter that
 *   keeps results (a cache) checks the token after the provider answers and keeps nothing when it was
 *   cancelled.
 *
 * Feature groups add adapters, API functions and `$` methods in files of their own (`groupFactories`).
 */

/** What a feature group adds: API functions under `languages`, and the `$` methods the workbench calls. */
export interface LanguageFeatureGroup {
  /** The functions of `vscode.languages` for one extension. */
  api(extension: HostExtensionDescription): Readonly<Record<string, unknown>>;
  /** The API types this group declares. */
  readonly types?: Readonly<Record<string, unknown>>;
  /** Called when an extension is released, after its registrations are gone. */
  release?(key: string): void;
  dispose?(): void;
}

export type LanguageFeatureGroupFactory = (features: ExtHostLanguageFeatures) => LanguageFeatureGroup;

/**
 * The diagnostics of one resource as `languages.getDiagnostics(resource)` gives them: the objects every
 * extension's collections hold, and the workbench's markers of other owners.
 */
export interface DiagnosticsSource {
  getDiagnostics(resource: vscode.Uri): vscode.Diagnostic[];
}

/** The feature groups, in the order of their members. Each group file exports its factory. */
const groupFactories: readonly LanguageFeatureGroupFactory[] = [
  createCompletionsGroup, createEditsGroup, createNavigationGroup, createWorkspaceSymbolsGroup, createReceiveOnlyGroup,
];

export enum IndentAction { None = 0, Indent = 1, IndentOutdent = 2, Outdent = 3 }
export enum SyntaxTokenType { Other = 0, Comment = 1, String = 2, RegEx = 3 }

interface Registration {
  readonly extension: HostExtensionDescription;
  readonly adapter: object;
  /** Frees what the registration holds on the extension host (a word pattern, an event listener). */
  readonly cleanup?: () => void;
}

function runCleanup(registration: Registration): void {
  try {
    registration.cleanup?.();
  } catch (error) {
    console.error(`[${registration.extension.id}] Freeing a language feature registration failed:`, error);
  }
}

/**
 * The commands of one kept result. They go with the result: `dispose` when the workbench releases it.
 */
export interface CommandStore {
  /** Keeps `command` and gives what crosses; a value that is not a command gives undefined. */
  toDto(command: vscode.Command | undefined): CommandDto | undefined;
  dispose(): void;
}

export class ExtHostLanguageFeatures implements ExtHostLanguageFeaturesSeamShape {
  private readonly registrations = new Map<number, Registration>();
  private nextHandle = 0;
  private readonly kept = new Map<number, { readonly extension: HostExtensionDescription; readonly command: vscode.Command }>();
  private nextCommand = 0;

  constructor(
    readonly proxy: MainThreadLanguageFeaturesShape,
    private readonly documents: ExtHostDocuments,
    readonly commands: ExtHostCommands,
    private readonly isLive: (key: string) => boolean,
    /** The bulk edit of the documents area: the one way a provider's workspace edit is applied. */
    readonly bulkEdits: MainThreadBulkEditsShape,
    private readonly diagnosticsSource?: DiagnosticsSource,
  ) {}

  /** The diagnostics there are for `resource`; none on a host without the diagnostics area. */
  diagnostics(resource: vscode.Uri): readonly vscode.Diagnostic[] {
    return this.diagnosticsSource?.getDiagnostics(resource) ?? [];
  }

  /** The registrations the host keeps, for tests that look for leaks. */
  get size(): number {
    return this.registrations.size;
  }

  /**
   * Keeps `adapter` under a new handle and tells the workbench with `register`. The disposable takes it
   * back; so does the extension's release. A registration the workbench refuses is logged and dropped.
   * `cleanup` runs once when the registration goes, whichever of these ends it.
   */
  register(extension: HostExtensionDescription, adapter: object, register: (handle: number) => Promise<void>, cleanup?: () => void): vscode.Disposable {
    const handle = ++this.nextHandle;
    const registration: Registration = { extension, adapter, cleanup };
    this.registrations.set(handle, registration);
    void register(handle).catch(error => {
      if (this.registrations.get(handle) !== registration) {
        return;
      }
      this.registrations.delete(handle);
      runCleanup(registration);
      if (this.isLive(extension.key)) {
        console.error(`[${extension.id}] A language feature registration failed:`, error);
      }
    });
    return new Disposable(() => this.unregister(handle));
  }

  private unregister(handle: number): void {
    const registration = this.registrations.get(handle);
    if (registration) {
      this.registrations.delete(handle);
      runCleanup(registration);
      void this.proxy.$unregister(registration.extension.key, handle).catch(() => {});
    }
  }

  /** The extension of a handle that is still registered. */
  extension(handle: number): HostExtensionDescription | undefined {
    return this.registrations.get(handle)?.extension;
  }

  /** The adapter of `handle` if it is still registered and of `kind`. */
  adapter<A>(handle: number, kind: abstract new (...args: any[]) => A): { adapter: A; extension: HostExtensionDescription } | undefined {
    const registration = this.registrations.get(handle);
    if (!registration || !(registration.adapter instanceof kind) || !this.isLive(registration.extension.key)) {
      return undefined;
    }
    return { adapter: registration.adapter as A, extension: registration.extension };
  }

  /** The host's copy of a document, if it has one and the extension may read it. */
  document(extension: HostExtensionDescription, uri: URI): vscode.TextDocument | undefined {
    const document = URI.isUri(uri) ? this.documents.getByUri(uri as unknown as vscode.Uri) : undefined;
    return document && !document.isClosed && this.documents.canRead(extension.key, document) ? document : undefined;
  }

  /** Whether the extension of `key` may read the host's open copy of a document (the `vscode.execute*` commands). */
  readable(key: string, uri: URI): boolean {
    const document = URI.isUri(uri) ? this.documents.getByUri(uri as unknown as vscode.Uri) : undefined;
    return !!document && !document.isClosed && this.documents.canRead(key, document);
  }

  /** The version of the host's copy of a document, if it has one open. */
  version(uri: URI): number | undefined {
    const document = URI.isUri(uri) ? this.documents.getByUri(uri as unknown as vscode.Uri) : undefined;
    return document && !document.isClosed ? document.version : undefined;
  }

  /**
   * Calls the adapter of `handle`: the fallback when it is gone, of another kind, cancelled or throws.
   * The answer does not wait for a provider after the token is cancelled.
   */
  async invoke<A, R>(
    handle: number,
    kind: abstract new (...args: any[]) => A,
    token: CancellationToken | undefined,
    fallback: R,
    callback: (adapter: A, extension: HostExtensionDescription) => R | PromiseLike<R>,
  ): Promise<R> {
    const found = this.adapter(handle, kind);
    if (!found || token?.isCancellationRequested) {
      return fallback;
    }
    const { adapter, extension } = found;
    let result: Promise<R>;
    try {
      result = Promise.resolve(callback(adapter, extension));
    } catch (error) {
      result = Promise.reject(error);
    }
    result = result.catch(error => {
      if (!(error instanceof CancellationError) && !(error instanceof Error && error.name === 'Canceled')) {
        console.error(`[${extension.id}] ${kind.name} failed:`, error);
      }
      return fallback;
    });
    if (!token) {
      return result;
    }
    let listener: vscode.Disposable | undefined;
    const cancelled = new Promise<R>(resolve => {
      listener = token.onCancellationRequested(() => resolve(fallback));
    });
    try {
      const value = await Promise.race([result, cancelled]);
      return token.isCancellationRequested ? fallback : value;
    } finally {
      listener?.dispose();
    }
  }

  /** `languages.match`: how well a selector matches a document, as VS Code scores it. */
  match(selector: vscode.DocumentSelector, document: vscode.TextDocument): number {
    return score(selectorFromDto(selectorToDto(selector)), document.uri as unknown as URI, document.languageId, true);
  }

  setLanguageConfiguration(extension: HostExtensionDescription, language: string, configuration: vscode.LanguageConfiguration): vscode.Disposable {
    if (typeof language !== 'string' || !language) {
      throw new TypeError('Expected a language id.');
    }
    const dto = languageConfigurationToDto(configuration);
    const word = setLanguageWordPattern(language, configuration.wordPattern);
    // The word pattern goes with the registration, also when the extension is released.
    return this.register(extension, {}, handle =>
      this.proxy.$setLanguageConfiguration(extension.key, handle, language, dto), () => word.dispose());
  }

  /** The commands kept for the workbench, for tests that look for leaks. */
  get commandCount(): number {
    return this.kept.size;
  }

  /** A store for the commands of one result of `extension`. */
  createCommandStore(extension: HostExtensionDescription): CommandStore {
    const refs = new Set<number>();
    return {
      toDto: command => {
        if (!command || typeof command.command !== 'string' || !command.command || typeof command.title !== 'string') {
          return undefined;
        }
        const ref = ++this.nextCommand;
        this.kept.set(ref, { extension, command });
        refs.add(ref);
        return { title: command.title, tooltip: typeof command.tooltip === 'string' ? command.tooltip : undefined, ref };
      },
      dispose: () => {
        for (const ref of refs) {
          this.kept.delete(ref);
        }
        refs.clear();
      },
    };
  }

  async $executeProviderCommand(ref: number): Promise<void> {
    const entry = this.kept.get(ref);
    if (!entry || !this.isLive(entry.extension.key)) {
      return;
    }
    const { command, arguments: args } = entry.command;
    await this.commands.executeCommand(entry.extension.key, command, Array.isArray(args) ? args : []);
  }

  /** Drops the registrations of an extension that was released, and tells the workbench. */
  release(key: string): void {
    for (const [handle, { extension }] of [...this.registrations]) {
      if (extension.key === key) {
        this.unregister(handle);
      }
    }
    for (const [ref, { extension }] of [...this.kept]) {
      if (extension.key === key) {
        this.kept.delete(ref);
      }
    }
  }

  dispose(): void {
    const registrations = [...this.registrations.values()];
    this.registrations.clear();
    for (const registration of registrations) {
      runCleanup(registration);
    }
    this.kept.clear();
  }
}

/** Checks a selector the way registering does: a selector of another shape throws. */
export function checkSelector(selector: vscode.DocumentSelector): LanguageSelectorDto {
  return selectorToDto(selector);
}

export function createLanguageFeaturesArea(
  rpc: RPCProtocol, documents: ExtHostDocuments, commands: ExtHostCommands, isLive: (key: string) => boolean,
  diagnostics: DiagnosticsSource | undefined, factories: readonly LanguageFeatureGroupFactory[] = groupFactories,
) {
  const features = new ExtHostLanguageFeatures(
    rpc.getProxy(MainThreadLanguageFeaturesProxy), documents, commands, isLive, rpc.getProxy(MainThreadBulkEditsProxy), diagnostics);
  const groups = factories.map(factory => factory(features));
  rpc.set(ExtHostLanguageFeaturesProxy, mergeHandlers([features, ...groups]) as unknown as ExtHostLanguageFeaturesSeamShape);
  return { features, groups };
}

extHostApiRegistry.register('languageFeatures', ({ rpc, getService, isLive }) => {
  const { features, groups } = createLanguageFeaturesArea(
    rpc, getService<ExtHostDocuments>('documents'), getService<ExtHostCommands>('commands'), isLive,
    getService<DiagnosticsSource>('diagnostics'));
  const types = Object.assign({ IndentAction, SyntaxTokenType }, ...groups.map(group => group.types ?? {}));
  return {
    service: features,
    create: extension => ({
      types,
      namespaces: {
        languages: Object.assign({
          match: (selector: vscode.DocumentSelector, document: vscode.TextDocument) => features.match(selector, document),
          setLanguageConfiguration: (language: string, configuration: vscode.LanguageConfiguration) =>
            features.setLanguageConfiguration(extension, language, configuration),
        } satisfies Pick<typeof vscode.languages, 'match' | 'setLanguageConfiguration'>, ...groups.map(group => group.api(extension))),
      },
    }),
    release: key => {
      features.release(key);
      for (const group of groups) {
        group.release?.(key);
      }
    },
    dispose: () => {
      for (const group of groups) {
        group.dispose?.();
      }
      features.dispose();
    },
  };
});
