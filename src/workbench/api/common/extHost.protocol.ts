import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';
import type { ExtensionHostStatus, HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';

import { MainThreadCommandsProxy, ExtHostCommandsProxy } from './extHost.protocol.commands.js';
export type * from './extHost.protocol.commands.js';
import { MainThreadTreeViewsProxy, ExtHostTreeViewsProxy } from './extHost.protocol.treeViews.js';
export type * from './extHost.protocol.treeViews.js';
import { MainThreadStatusBarProxy } from './extHost.protocol.statusBar.js';
export type * from './extHost.protocol.statusBar.js';
import { MainThreadMessageServiceProxy } from './extHost.protocol.messages.js';
export type * from './extHost.protocol.messages.js';

export interface MainThreadExtensionServiceShape {
  $setActivationStatus(extension: string, status: ExtensionHostStatus): Promise<void>;
}

export interface ExtHostExtensionServiceShape {
  $activateByEvent(event: string, skipExtension?: string): Promise<void>;
  $deltaExtensions(added: HostExtensionDescription[], removed: string[]): Promise<void>;
}

export const MainContext = {
  MainThreadTreeViews: MainThreadTreeViewsProxy,
  MainThreadStatusBar: MainThreadStatusBarProxy,
  MainThreadMessageService: MainThreadMessageServiceProxy,
  MainThreadCommands: MainThreadCommandsProxy,
  MainThreadExtensionService: createProxyIdentifier<MainThreadExtensionServiceShape>('MainThreadExtensionService'),
};

export const ExtHostContext = {
  ExtHostTreeViews: ExtHostTreeViewsProxy,
  ExtHostCommands: ExtHostCommandsProxy,
  ExtHostExtensionService: createProxyIdentifier<ExtHostExtensionServiceShape>('ExtHostExtensionService'),
};
