import { IWebExtensionsScannerService } from '../../services/extensionManagement/common/extensionManagementService.js';
import { ExtensionResourceUrls } from './extensionResourceUrls.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { loadExtensionBundle } from '../../services/extensions/browser/extensionLocalization.js';
import { URI } from '../../../base/common/uri.js';
import { EXTERNAL_SCHEMES, IOpenerService } from '../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { ExtHostStorageProxy, MainThreadRuntimeProxy, MainThreadStorageProxy } from '../common/extHost.protocol.runtime.js';
import { IExtensionStorage, MainThreadStorage } from './mainThreadStorage.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';

let sessionId: string | undefined;
let memoryMachineId: string | undefined;

function randomIdentifier(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

mainThreadCustomers.register('runtime', ({ rpc, instantiation, getExtension }) => {
  const state = instantiation.invokeFunction(accessor => accessor.get(IExtensionStorage));
  const storage = new MainThreadStorage(state, getExtension, rpc.getProxy(ExtHostStorageProxy),
    () => instantiation.invokeFunction(accessor => accessor.get(IWebExtensionsScannerService)).scanUserExtensions());
  rpc.set(MainThreadStorageProxy, storage);
  const resources = new ExtensionResourceUrls(
    () => instantiation.invokeFunction(accessor => accessor.get(IFileService)),
    () => (instantiation.invokeFunction(accessor => accessor.get(IExtensionService)).extensions ?? []).map(item => item.location),
    getExtension,
  );
  const check = (key: string) => {
    if (typeof key !== 'string' || !getExtension(key)) {
      throw new Error('The extension is no longer registered.');
    }
  };
  rpc.set(MainThreadRuntimeProxy, {
    async $asBrowserUri(key, value, forWorker) {
      check(key);
      if (typeof forWorker !== 'boolean') {
        throw new TypeError('Invalid extension resource request.');
      }
      return resources.asBrowserUri(key, value, forWorker);
    },
    async $getLocalization(key) {
      check(key);
      const files = instantiation.invokeFunction(accessor => accessor.get(IFileService));
      return loadExtensionBundle(files, getExtension(key)!);
    },
    async $getEnvironment(key) {
      check(key);
      const storage = instantiation.invokeFunction(accessor => accessor.get(IStorageService));
      const setting = 'extensions.machineId';
      const create = () => {
        let machineId: string | undefined;
        try {
          storage.storeImmediately(setting, previous => machineId = previous || randomIdentifier(),
            StorageScope.PROFILE, StorageTarget.MACHINE);
          return machineId!;
        } catch {
          return memoryMachineId ??= randomIdentifier();
        }
      };
      const machineId = storage.get(setting, StorageScope.PROFILE)
        ?? (navigator.locks ? await navigator.locks.request('writing-room:extensions.machineId', create) : create());
      return { machineId, sessionId: sessionId ??= randomIdentifier() };
    },
    async $readClipboard(key) {
      check(key);
      return navigator.clipboard.readText();
    },
    async $writeClipboard(key, value) {
      check(key);
      if (typeof value !== 'string') {
        throw new TypeError('Clipboard text must be a string.');
      }
      await navigator.clipboard.writeText(value);
    },
    async $openExternal(key, target) {
      check(key);
      if (!URI.isUri(target) || !EXTERNAL_SCHEMES.has(target.scheme.toLowerCase())) {
        return false;
      }
      return instantiation.invokeFunction(accessor => accessor.get(IOpenerService)).open(target);
    },
  });
  return {
    remove(key) { resources.remove(key); storage.remove(key); },
    dispose() { resources.dispose(); storage.dispose(); },
  };
});
