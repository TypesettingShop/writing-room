import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { URI } from '../../../base/common/uri.js';
import { score } from '../../../editor/common/languageSelector.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { RPCProtocol } from '../../services/extensions/common/rpcProtocol.js';
import { ExtHostLanguageFeaturesProxy, MainThreadLanguageFeaturesProxy, mergeHandlers } from './extHost.protocol.languageFeatures.js';
import type { LanguageSelectorDto, MainThreadLanguageFeaturesShape } from './extHost.protocol.languageFeatures.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';
import type { ExtHostCommands } from './extHostCommands.js';
import type { ExtHostDocuments } from './extHostDocuments.js';
import { languageConfigurationToDto, selectorFromDto, selectorToDto } from './extHostLanguageConverters.js';
import { Disposable } from './extHostTypes.js';
import { setLanguageWordPattern } from './extHostLanguageWordPatterns.js';

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

/** The feature groups, in the order of their members. Each group file exports its factory. */
const groupFactories: readonly LanguageFeatureGroupFactory[] = [];

export enum IndentAction { None = 0, Indent = 1, IndentOutdent = 2, Outdent = 3 }
export enum SyntaxTokenType { Other = 0, Comment = 1, String = 2, RegEx = 3 }

interface Registration {
  readonly extension: HostExtensionDescription;
  readonly adapter: object;
}

export class ExtHostLanguageFeatures {
  private readonly registrations = new Map<number, Registration>();
  private nextHandle = 0;

  constructor(
    readonly proxy: MainThreadLanguageFeaturesShape,
    private readonly documents: ExtHostDocuments,
    readonly commands: ExtHostCommands,
    private readonly isLive: (key: string) => boolean,
  ) {}

  /** The registrations the host keeps, for tests that look for leaks. */
  get size(): number {
    return this.registrations.size;
  }

  /**
   * Keeps `adapter` under a new handle and tells the workbench with `register`. The disposable takes it
   * back; so does the extension's release. A registration the workbench refuses is logged and dropped.
   */
  register(extension: HostExtensionDescription, adapter: object, register: (handle: number) => Promise<void>): vscode.Disposable {
    const handle = ++this.nextHandle;
    this.registrations.set(handle, { extension, adapter });
    void register(handle).catch(error => {
      if (this.registrations.delete(handle) && this.isLive(extension.key)) {
        console.error(`[${extension.id}] A language feature registration failed:`, error);
      }
    });
    return new Disposable(() => this.unregister(handle));
  }

  private unregister(handle: number): void {
    const registration = this.registrations.get(handle);
    if (registration) {
      this.registrations.delete(handle);
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
    const registration = this.register(extension, {}, handle =>
      this.proxy.$setLanguageConfiguration(extension.key, handle, language, dto));
    return new Disposable(() => {
      word.dispose();
      registration.dispose();
    });
  }

  /** Drops the registrations of an extension that was released, and tells the workbench. */
  release(key: string): void {
    for (const [handle, { extension }] of [...this.registrations]) {
      if (extension.key === key) {
        this.unregister(handle);
      }
    }
  }

  dispose(): void {
    this.registrations.clear();
  }
}

/** Checks a selector the way registering does: a selector of another shape throws. */
export function checkSelector(selector: vscode.DocumentSelector): LanguageSelectorDto {
  return selectorToDto(selector);
}

export function createLanguageFeaturesArea(
  rpc: RPCProtocol, documents: ExtHostDocuments, commands: ExtHostCommands, isLive: (key: string) => boolean,
  factories: readonly LanguageFeatureGroupFactory[] = groupFactories,
) {
  const features = new ExtHostLanguageFeatures(rpc.getProxy(MainThreadLanguageFeaturesProxy), documents, commands, isLive);
  const groups = factories.map(factory => factory(features));
  rpc.set(ExtHostLanguageFeaturesProxy, mergeHandlers(groups));
  return { features, groups };
}

extHostApiRegistry.register('languageFeatures', ({ rpc, getService, isLive }) => {
  const { features, groups } = createLanguageFeaturesArea(
    rpc, getService<ExtHostDocuments>('documents'), getService<ExtHostCommands>('commands'), isLive);
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
