import type * as vscode from 'vscode';
import { MainThreadBulkEditsProxy } from './extHost.protocol.documents.js';
import { ExtHostBulkEdits } from './extHostBulkEdits.js';
import type { ExtHostDocuments } from './extHostDocuments.js';
import { ExtHostFileSystemEventService } from './extHostFileSystemEventService.js';
import type { FileSystemProviderCapabilities } from '../../../platform/files/common/files.js';
import { ExtHostFileSystemProviderProxy, ExtHostFileSystemProxy, MainThreadFileSystemProxy } from './extHost.protocol.fileSystem.js';
import type { ExtHostFileSystemShape } from './extHost.protocol.fileSystem.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';
import { ExtHostFileSystemConsumer, FilePermission, FileSystemError, FileType } from './extHostFileSystemConsumer.js';
import { ExtHostWorkspace } from './extHostWorkspace.js';
import { ExtHostFileSystemProvider, FileChangeType } from './extHostFileSystemProvider.js';

extHostApiRegistry.register('fileSystem', ({ rpc, isLive, getService }) => {
  const proxy = rpc.getProxy(MainThreadFileSystemProxy);
  const externalCapabilities = new Map<string, FileSystemProviderCapabilities>();
  const providers = new ExtHostFileSystemProvider(proxy, scheme => externalCapabilities.get(scheme));
  const consumer = new ExtHostFileSystemConsumer(proxy, isLive,
    scheme => providers.getCapabilities(scheme) ?? externalCapabilities.get(scheme));
  const workspace = new ExtHostWorkspace();
  const edits = new ExtHostBulkEdits(rpc.getProxy(MainThreadBulkEditsProxy), getService<ExtHostDocuments>('documents'));
  const events = new ExtHostFileSystemEventService(proxy, () => workspace.folders, (key, edit) => edits.apply(key, edit));
  let duringInit: Set<string> | undefined = new Set<string>();
  const updateCapability = (scheme: string, capabilities: FileSystemProviderCapabilities | undefined) => {
    if (capabilities === undefined) {
      externalCapabilities.delete(scheme);
    } else {
      externalCapabilities.set(scheme, capabilities);
    }
  };
  rpc.set(ExtHostFileSystemProviderProxy, providers);
  rpc.set(ExtHostFileSystemProxy, {
    $acceptFileChanges: events.$acceptFileChanges.bind(events),
    $acceptFileOperation: events.$acceptFileOperation.bind(events),
    $participateInFileOperation: events.$participateInFileOperation.bind(events),
    async $acceptFileSystemCapability(scheme, capabilities) {
      duringInit?.add(scheme);
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
      types: { FileType, FilePermission, FileSystemError, FileChangeType },
      namespaces: { workspace: Object.assign(workspace.createApi(), events.createApi(key), {
        fs: consumer.createApi(key),
        registerFileSystemProvider: (...args: Parameters<typeof vscode.workspace.registerFileSystemProvider>) =>
          providers.register(key, ...args),
      }) },
    }),
    release: key => {
      events.release(key);
      providers.release(key);
    },
    dispose: () => {
      events.dispose();
      providers.dispose();
    },
  };
});
