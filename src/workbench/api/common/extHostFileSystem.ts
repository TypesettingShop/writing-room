import type { FileSystemProviderCapabilities } from '../../../platform/files/common/files.js';
import { ExtHostFileSystemProxy, MainThreadFileSystemProxy } from './extHost.protocol.fileSystem.js';
import type { ExtHostFileSystemShape } from './extHost.protocol.fileSystem.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';
import { ExtHostFileSystemConsumer, FilePermission, FileSystemError, FileType } from './extHostFileSystemConsumer.js';
import { ExtHostWorkspace } from './extHostWorkspace.js';

extHostApiRegistry.register('fileSystem', ({ rpc, isLive }) => {
  const proxy = rpc.getProxy(MainThreadFileSystemProxy);
  const consumer = new ExtHostFileSystemConsumer(proxy, isLive);
  const workspace = new ExtHostWorkspace();
  let duringInit: Map<string, FileSystemProviderCapabilities | undefined> | undefined = new Map();
  const updateCapability = (scheme: string, capabilities: FileSystemProviderCapabilities | undefined) => {
    if (capabilities === undefined) {
      consumer.capabilities.delete(scheme);
    } else {
      consumer.capabilities.set(scheme, capabilities);
    }
  };
  rpc.set(ExtHostFileSystemProxy, {
    async $acceptFileSystemCapability(scheme, capabilities) {
      duringInit?.set(scheme, capabilities);
      updateCapability(scheme, capabilities);
    },
  } satisfies ExtHostFileSystemShape);
  const ready = proxy.$initializeFileSystem().then(({ folders, capabilities }) => {
    workspace.initialize(folders);
    for (const [scheme, value] of capabilities) {
      if (!duringInit?.has(scheme)) {
        updateCapability(scheme, value);
      }
    }
    duringInit = undefined;
  }, error => {
    duringInit = undefined;
    console.error('The extension host could not initialize the file system:', error);
  });
  return {
    ready,
    create: ({ key }) => ({
      types: { FileType, FilePermission, FileSystemError },
      namespaces: { workspace: Object.assign(workspace.createApi(), { fs: consumer.createApi(key) }) },
    }),
  };
});
