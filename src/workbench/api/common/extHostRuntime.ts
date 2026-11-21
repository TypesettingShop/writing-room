import { compatibilityFragments } from './extHostCompatibility.js';
import { ExtensionLocalization } from './extHostLocalizationService.js';
import { URI } from '../../../base/common/uri.js';
import type * as vscode from 'vscode';
import { extensionGlobalStorageUri, extensionWorkspaceStorageUri, extensionLogUri } from '../../services/extensions/common/extensionStoragePaths.js';
import { ExtHostStorageProxy, MainThreadRuntimeProxy, MainThreadStorageProxy } from './extHost.protocol.runtime.js';
import { extHostApiRegistry, promiseApiMethod } from './extHostApiRegistry.js';
import { extensionActivation } from './extHostExtensionActivator.js';
import { logExtensionHostError } from './extHostRuntimeLog.js';
import { ExtHostStorage } from './extHostStorage.js';
import { Disposable, LogLevel, Uri } from './extHostTypes.js';
import type { ExtHostMemento } from './extHostMemento.js';

const noEvent = () => new Disposable(() => {});

class TelemetryTrustedValue<T> {
  constructor(readonly value: T) {}
}

function createTelemetryLogger(): vscode.TelemetryLogger {
  return Object.freeze({
    isUsageEnabled: false, isErrorsEnabled: false, onDidChangeEnableStates: noEvent,
    logUsage() {}, logError() {}, dispose() {},
  });
}

function environmentVariables(): vscode.GlobalEnvironmentVariableCollection {
  return {
    persistent: true,
    description: undefined,
    replace() {},
    append() {},
    prepend() {},
    get: () => undefined,
    forEach() {},
    delete() {},
    clear() {},
    *[Symbol.iterator]() {},
    getScoped: () => environmentVariables(),
  };
}

function mementoApi(memento: ExtHostMemento): vscode.Memento {
  return {
    keys: () => memento.keys(),
    get: memento.get.bind(memento),
    update: (key, value) => memento.update(key, value),
  };
}

extHostApiRegistry.register('runtime', ({ rpc, isLive }) => {
  const storage = new ExtHostStorage(rpc.getProxy(MainThreadStorageProxy));
  rpc.set(ExtHostStorageProxy, storage);
  const main = rpc.getProxy(MainThreadRuntimeProxy);
  return {
    create: extension => {
      const access = extensionActivation.get(extension);
      if (!access) {
        return {};
      }
      const { id, key, runtime } = extension;
      access.logError = (message, error) => logExtensionHostError(rpc, main, id, message, error);
      const checkLive = () => {
        if (!isLive(key)) {
          throw new Error(`Extension '${id}' is no longer active.`);
        }
      };
      const state = storage.create(key, checkLive);
      const localization = new ExtensionLocalization();
      let machineId = '';
      let sessionId = '';
      if (runtime) {
        access.prepare = async () => {
          const [, environment, bundle] = await Promise.all([
            state.initialize(key), main.$getEnvironment(key),
            extension.manifest.l10n === undefined ? undefined : main.$getLocalization(key),
          ]);
          localization.accept(bundle);
          ({ machineId, sessionId } = environment);
        };
      }
      const clipboard: vscode.Clipboard = Object.freeze({
        readText: async () => { checkLive(); return main.$readClipboard(key); },
        writeText: async (value: string) => { checkLive(); await main.$writeClipboard(key, value); },
      });
      const extensionUri = Uri.parse(extension.location);
      const globalStorageUri = extensionGlobalStorageUri(id);
      const storageUri = runtime?.workspaceId ? extensionWorkspaceStorageUri(runtime.workspaceId, id) : undefined;
      const logUri = extensionLogUri(id);
      const compatibility = compatibilityFragments(noEvent);
      return {
        types: {
          ...compatibility.types,
          UIKind: Object.freeze({ Desktop: 1, Web: 2 }),
          TelemetryTrustedValue,
          ExtensionMode: Object.freeze({ Production: 1, Development: 2, Test: 3 }),
          ExtensionKind: Object.freeze({ UI: 1, Workspace: 2 }),
          EnvironmentVariableMutatorType: Object.freeze({ Replace: 1, Append: 2, Prepend: 3 }),
        },
        namespaces: {
          tasks: compatibility.tasks,
          window: compatibility.window,
          l10n: localization.api(),
          env: {
            appName: 'Writing Room', appHost: 'web', uiKind: 2, uriScheme: 'writing-room',
            language: runtime?.locale ?? 'en',
            get machineId() { return machineId; },
            get sessionId() { return sessionId; },
            remoteName: undefined, shell: '', isTelemetryEnabled: false,
            onDidChangeTelemetryEnabled: noEvent, logLevel: LogLevel.Info, onDidChangeLogLevel: noEvent,
            clipboard,
            openExternal: promiseApiMethod((target: vscode.Uri) => main.$openExternal(key, target as unknown as URI)),
            asExternalUri: promiseApiMethod(async (target: vscode.Uri) => {
              if (!URI.isUri(target) || !/^https?$/i.test(target.scheme)) {
                throw new Error('Only HTTP and HTTPS URIs can be resolved externally.');
              }
              return target;
            }),
            createTelemetryLogger,
          } satisfies typeof vscode.env,
          extensions: {
            get all() { return access.all(); },
            getExtension: access.getExtension as typeof vscode.extensions.getExtension,
            onDidChange: access.onDidChange,
          } satisfies typeof vscode.extensions,
          workspace: {
            ...compatibility.workspace,
            isTrusted: true,
            onDidGrantWorkspaceTrust: noEvent,
          } satisfies Pick<typeof vscode.workspace, 'isTrusted' | 'onDidGrantWorkspaceTrust'>,
        },
        context: {
          globalState: Object.freeze({ ...mementoApi(state.global), setKeysForSync() {} }),
          workspaceState: Object.freeze(mementoApi(state.workspace)),
          secrets: state.secrets,
          extensionPath: extensionUri.fsPath,
          asAbsolutePath: (relativePath: string) => Uri.joinPath(extensionUri, relativePath).fsPath,
          extensionMode: 1,
          globalStorageUri,
          globalStoragePath: globalStorageUri.fsPath,
          storageUri,
          storagePath: storageUri?.fsPath,
          logUri,
          logPath: logUri.fsPath,
          environmentVariableCollection: environmentVariables(),
        } satisfies Pick<vscode.ExtensionContext,
          'globalState' | 'workspaceState' | 'secrets' | 'extensionPath' | 'asAbsolutePath' | 'extensionMode'
          | 'globalStorageUri' | 'globalStoragePath' | 'storageUri' | 'storagePath' | 'logUri' | 'logPath' | 'environmentVariableCollection'>,
      };
    },
    release: key => storage.release(key),
  };
});
