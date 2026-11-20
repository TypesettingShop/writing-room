import { IWebExtensionsScannerService } from '../../services/extensionManagement/common/extensionManagementService.js';
import { ExtensionResourceUrls } from './extensionResourceUrls.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { loadExtensionBundle } from '../../services/extensions/browser/extensionLocalization.js';
import { URI } from '../../../base/common/uri.js';
import { EXTERNAL_SCHEMES, IOpenerService } from '../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IOutputService } from '../../services/output/common/output.js';
import { boundExtensionHostLogLine, ExtHostStorageProxy, MainThreadRuntimeProxy, MainThreadStorageProxy } from '../common/extHost.protocol.runtime.js';
import { IExtensionStorage, MainThreadStorage } from './mainThreadStorage.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';

let sessionId: string | undefined;
let memoryMachineId: string | undefined;

function randomIdentifier(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

const machineIdKey = 'extensions.machineId';
export const machineIdLockName = 'writing-room:extensions.machineId';

/** Runs `callback` while every tab of the origin is kept out of the machine id. */
export type MachineIdLock = (name: string, callback: () => string) => Promise<string>;

function browserLock(): MachineIdLock | undefined {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks && ((name, callback) => locks.request(name, callback));
}

/**
 * The machine id saved in the profile, created under a Web Lock so tabs opening together agree on it. When the
 * storage is in memory mode, or the lock or the write fails, it is a value that stays the same for this page and
 * is not saved. No failure rejects, since every extension waits for this before it activates.
 */
export async function resolveMachineId(storage: IStorageService, lock: MachineIdLock | undefined = browserLock()): Promise<string> {
  const saved = storage.get(machineIdKey, StorageScope.PROFILE);
  if (saved) {
    return saved;
  }
  const pageMachineId = () => memoryMachineId ??= randomIdentifier();
  if (storage.usesMemory) {
    // No value is shared with other tabs, and a browser that blocks storage denies the lock as well.
    return pageMachineId();
  }
  const create = () => {
    let machineId: string | undefined;
    try {
      storage.storeImmediately(machineIdKey, previous => machineId = previous || randomIdentifier(),
        StorageScope.PROFILE, StorageTarget.MACHINE);
      return machineId!;
    } catch {
      return pageMachineId();
    }
  };
  if (!lock) {
    return create();
  }
  try {
    return await lock(machineIdLockName, create);
  } catch {
    // The callback never ran: the browser denied the lock.
    return pageMachineId();
  }
}

const extensionHostLogChannelId = 'workerexthost';

export function appendExtensionHostLog(output: () => IOutputService, line: unknown): void {
  if (typeof line !== 'string' || !line.length) {
    return;
  }
  const service = output();
  const channel = service.getChannel(extensionHostLogChannelId)
    ?? service.registerChannel({ id: extensionHostLogChannelId, label: 'Extension Host (Worker)' });
  channel.append(boundExtensionHostLogLine(line));
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
    async $logExtensionHost(line) {
      appendExtensionHostLog(() => instantiation.invokeFunction(accessor => accessor.get(IOutputService)), line);
    },
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
      const machineId = await resolveMachineId(instantiation.invokeFunction(accessor => accessor.get(IStorageService)));
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
