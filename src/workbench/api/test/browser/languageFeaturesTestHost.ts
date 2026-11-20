import type * as vscode from 'vscode';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { IMonacoTextModel, MonacoNamespace } from '../../../../editor/browser/monaco.js';
import type { OpenOptions } from '../../../../platform/opener/common/opener.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';
import { createMainThreadLanguageFeatures } from '../../browser/mainThreadLanguageFeatures.js';
import type { MainThreadLanguageFeatureGroupFactory } from '../../browser/mainThreadLanguageFeatures.js';
import { ExtHostLanguageFeaturesProxy, MainThreadLanguageFeaturesProxy } from '../../common/extHost.protocol.languageFeatures.js';
import { MainThreadBulkEditsProxy } from '../../common/extHost.protocol.documents.js';
import type { DocumentSnapshot, MainThreadBulkEditsShape, WorkspaceEditOperation } from '../../common/extHost.protocol.documents.js';
import type { ExtHostCommands } from '../../common/extHostCommands.js';
import { ExtHostDiagnostics } from '../../common/extHostDiagnostics.js';
import type { MainThreadDiagnosticsShape } from '../../common/extHost.protocol.diagnostics.js';
import { ExtHostDocuments } from '../../common/extHostDocuments.js';
import { createLanguageFeaturesArea } from '../../common/extHostLanguageFeatures.js';
import type { LanguageFeatureGroupFactory } from '../../common/extHostLanguageFeatures.js';

/*
 * A language feature test host: the extension host's area and the workbench's customer over a real RPC
 * pair, a fake Monaco that records what is registered, and documents the host mirrors. A feature group's
 * tests pass the group's factories of both sides; `undefined` takes the area's own lists.
 */

export const testExtensions: Readonly<Record<string, HostExtensionDescription>> = {
  '1': {
    key: '1', id: 'test.first', location: 'https://example.test/1/', entry: '', activationEvents: [],
    manifest: { name: 'first', publisher: 'test', version: '1.0.0', contributes: { commands: [{ command: 'test.first.run', title: 'Run' }] } },
  },
  '2': { key: '2', id: 'test.second', location: 'https://example.test/2/', entry: '', activationEvents: [], manifest: { name: 'second', publisher: 'test', version: '1.0.0' } },
};

/** One `monaco.languages.register*Provider` call: `kind` is the name after `register`. */
export interface RecordedProvider {
  readonly kind: string;
  readonly selector: unknown;
  readonly provider: any;
  readonly args: readonly unknown[];
}

export function fakeMonaco() {
  const providers: RecordedProvider[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const configurations: { languageId: string; configuration: unknown }[] = [];
  const languages = new Proxy({
    setLanguageConfiguration: (languageId: string, configuration: unknown) => {
      const entry = { languageId, configuration };
      configurations.push(entry);
      return toDisposable(() => configurations.splice(configurations.indexOf(entry), 1));
    },
  } as Record<string, unknown>, {
    get(target, name) {
      if (typeof name === 'string' && name in target) {
        return target[name];
      }
      if (typeof name === 'string' && /^register\w*Provider$/.test(name)) {
        return (selector: unknown, provider: unknown, ...args: unknown[]) => {
          const entry: RecordedProvider = { kind: name.slice('register'.length), selector, provider, args };
          providers.push(entry);
          return toDisposable(() => {
            const index = providers.indexOf(entry);
            if (index !== -1) {
              providers.splice(index, 1);
            }
          });
        };
      }
      return undefined;
    },
  });
  /** The models Monaco has, by URI; `editor.getModel` finds them. */
  const models = new Map<string, IMonacoTextModel>();
  const openers: unknown[] = [];
  const editor = {
    getModel: (uri: { toString(): string }) => models.get(uri.toString()) ?? null,
    registerEditorOpener: (opener: unknown) => {
      openers.push(opener);
      return toDisposable(() => openers.splice(openers.indexOf(opener), 1));
    },
    registerCommand: (id: string, handler: (accessor: unknown, ...args: unknown[]) => unknown) => {
      if (commands.has(id)) {
        throw new Error('Command registered twice: ' + id);
      }
      commands.set(id, (...args) => handler(undefined, ...args));
      return toDisposable(() => commands.delete(id));
    },
  };
  const Uri = { from: (components: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }) => URI.from(components) };
  const monaco = { languages, editor, Uri } as unknown as MonacoNamespace;
  return {
    monaco, providers, commands, configurations, models, openers,
    /** Monaco knows the model (an open editor's), as `editor.getModel` finds it. */
    addModel: (model: IMonacoTextModel) => models.set(URI.from(model.uri).toString(), model),
    /** The providers of one kind, e.g. `HoverProvider`. */
    of: (kind: string) => providers.filter(entry => entry.kind === kind),
    /** Runs a registered Monaco command as Monaco would. */
    run: (command: { id: string; arguments?: unknown[] }) => commands.get(command.id)?.(...(command.arguments ?? [])),
  };
}

export const workspaceUri = (path: string) => URI.parse('vscode-vfs://writing-room/workspace/' + path);

/** A model as Monaco gives it to a provider: its URI and the text the tests read. */
export function testModel(uri: URI, text: string, options: { length?: number; version?: number; language?: string } = {}): IMonacoTextModel {
  let version = options.version ?? 1;
  return {
    uri: { scheme: uri.scheme, authority: uri.authority, path: uri.path, query: uri.query, fragment: uri.fragment },
    isDisposed: () => false,
    getValueLength: () => options.length ?? text.length,
    getVersionId: () => version,
    getLanguageId: () => options.language ?? 'markdown',
    getValue: () => text,
    getLineCount: () => text.split('\n').length,
    getLineContent: (line: number) => text.split('\n')[line - 1] ?? '',
    getOptions: () => ({ tabSize: 4, indentSize: 4, insertSpaces: true }),
    getWordUntilPosition: () => ({ word: '', startColumn: 1, endColumn: 1 }),
    getWordAtPosition: () => null,
    /** For tests: the model changes. */
    bumpVersion: () => { version++; },
  } as unknown as IMonacoTextModel;
}

export const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
};

export interface LanguageFeatureTestHostOptions {
  readonly hostGroups?: readonly LanguageFeatureGroupFactory[];
  readonly mainGroups?: readonly MainThreadLanguageFeatureGroupFactory[];
  readonly documents?: readonly { readonly uri: URI; readonly text: string; readonly language?: string; readonly version?: number }[];
  readonly monaco?: () => Promise<MonacoNamespace>;
  /** Follows a document link's target; the default records it and refuses. */
  readonly openLink?: (target: URI, options: OpenOptions) => Promise<boolean>;
  /** Without the diagnostics area, as a host that has none: `false`. */
  readonly diagnostics?: boolean;
}

export async function createLanguageFeatureTestHost(options: LanguageFeatureTestHostOptions = {}) {
  const { port1, port2 } = new MessageChannel();
  /** Every RPC message the workbench sent. */
  const sent: unknown[] = [];
  const post = port1.postMessage.bind(port1);
  port1.postMessage = ((message: unknown, transfer?: Transferable[]) => {
    sent.push(message);
    post(message, transfer as Transferable[]);
  }) as typeof port1.postMessage;
  const main = new RPCProtocol(port1);
  const worker = new RPCProtocol(port2);
  const fake = fakeMonaco();
  const live = new Set(Object.keys(testExtensions));
  const documents = new ExtHostDocuments({ $startDocumentSync: async () => {} } as never, key => live.has(key));
  const snapshots: DocumentSnapshot[] = (options.documents ?? []).map((document, index) => ({
    id: 'doc' + index, uri: document.uri, lines: document.text.split('\n'), eol: '\n',
    version: document.version ?? 1, language: document.language ?? 'markdown', dirty: false,
  }));
  await documents.$acceptDocumentDelta({ added: snapshots });
  /** What the extensions ran with `commands.executeCommand`. */
  const executed: { extension: string; id: string; args: unknown[] }[] = [];
  /** The API commands the groups registered, as `ExtHostCommands` keeps them. */
  const apiHandlers = new Map<string, (extension: string, args: unknown[]) => Promise<unknown>>();
  const commands = {
    registerApiCommand: (id: string, handler: (extension: string, args: unknown[]) => Promise<unknown>) => {
      if (apiHandlers.has(id)) {
        throw new Error(`API command '${id}' already exists`);
      }
      apiHandlers.set(id, handler);
      return toDisposable(() => apiHandlers.delete(id));
    },
    executeCommand: async (extension: string, id: string, args: unknown[]) => {
      const api = apiHandlers.get(id);
      if (api) {
        return api(extension, args);
      }
      executed.push({ extension, id, args });
      return undefined;
    },
  } as unknown as ExtHostCommands;
  /** Runs an API command as `commands.executeCommand` of extension `key` would. */
  const apiCommands = {
    execute: (key: string, id: string, args: unknown[]) => commands.executeCommand(key, id, args),
    ids: () => [...apiHandlers.keys()],
  };
  /** The extension host's diagnostics; the workbench side only takes what crosses. */
  const diagnostics = options.diagnostics === false ? undefined : new ExtHostDiagnostics({
    $changeMany: async () => {}, $clear: async () => {}, $requestMarkers: async () => {},
  } satisfies MainThreadDiagnosticsShape);
  const host = createLanguageFeaturesArea(worker, documents, commands, key => live.has(key), diagnostics, options.hostGroups);
  /** The warnings the workbench showed the user. */
  const warnings: string[] = [];
  /** The link targets the workbench was asked to open. */
  const followed: { target: URI; options: OpenOptions }[] = [];
  const workbench = createMainThreadLanguageFeatures(main.getProxy(ExtHostLanguageFeaturesProxy),
    key => live.has(key) ? testExtensions[key] : undefined,
    {
      monaco: options.monaco ?? (async () => fake.monaco), waitForLanguage: async () => {}, warn: message => warnings.push(message),
      openLink: options.openLink ?? (async (target, openOptions) => {
        followed.push({ target, options: openOptions });
        return false;
      }),
    }, options.mainGroups);
  main.set(MainThreadLanguageFeaturesProxy, workbench.handlers as never);
  /**
   * A bulk edit on the workbench side that records what the extension host asked it to apply and answers
   * with `answer` (applied, by default).
   */
  const bulkEdits = {
    calls: [] as { extension: string; operations: WorkspaceEditOperation[]; isRefactoring?: boolean }[],
    answer: (_operations: WorkspaceEditOperation[]): boolean | Promise<boolean> => true,
  };
  main.set(MainThreadBulkEditsProxy, {
    $applyWorkspaceEdit: async (extension, operations, isRefactoring) => {
      bulkEdits.calls.push({ extension, operations, isRefactoring });
      return bulkEdits.answer(operations);
    },
  } satisfies MainThreadBulkEditsShape);
  /** The `languages` functions the groups give one extension. */
  const api = (key: string) => Object.assign({}, ...host.groups.map(group => group.api(testExtensions[key]))) as typeof vscode.languages;
  const disposables: IDisposable[] = [];
  return {
    ...fake, host, features: host.features, workbench, seam: workbench.seam, api, live, sent, documents, executed, main, worker, bulkEdits, warnings,
    apiCommands, followed, diagnostics,
    document: (uri: URI) => documents.getByUri(uri as unknown as vscode.Uri)!,
    dispose: () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
      workbench.dispose();
      for (const group of host.groups) {
        group.dispose?.();
      }
      host.features.dispose();
      diagnostics?.dispose();
      documents.dispose();
      main.dispose();
      worker.dispose();
    },
  };
}
