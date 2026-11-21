import { Schemas } from '../../../base/common/network.js';
import { registerExtensionEntryReader } from '../../services/extensions/common/extensionResources.js';
import { MainThreadExtensionResourcesProxy } from './extHost.protocol.packages.js';
import type { MainThreadExtensionResourcesShape } from './extHost.protocol.packages.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';

// One extension host runs per worker. The entry reader reaches the main thread through its connection.
let mainThread: MainThreadExtensionResourcesShape | undefined;

registerExtensionEntryReader(Schemas.vscodeUserData, async (entry, signal) => {
  if (!mainThread) {
    throw new Error('The extension host is not connected.');
  }
  // The main thread decides which package files are readable; the worker has no storage access of its own.
  const bytes = await mainThread.$readPackageEntry(entry.toString());
  signal.throwIfAborted();
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('The main thread returned an invalid extension entry.');
  }
  return bytes;
});

extHostApiRegistry.register('packages', ({ rpc }) => {
  const proxy = rpc.getProxy(MainThreadExtensionResourcesProxy);
  mainThread = proxy;
  return {
    dispose() {
      if (mainThread === proxy) {
        mainThread = undefined;
      }
    },
  };
});
