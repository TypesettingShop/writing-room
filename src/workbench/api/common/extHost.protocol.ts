import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';
import type { ExtensionHostStatus, HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';

export interface MainThreadCommandsShape {
  $registerCommand(extension: string, id: string): Promise<void>;
  $unregisterCommand(extension: string, id: string): Promise<void>;
  $executeCommand(extension: string, id: string, args: unknown[]): Promise<unknown>;
}

export interface ExtHostCommandsShape {
  $executeContributedCommand(extension: string, id: string, args: unknown[]): Promise<unknown>;
}

export interface MainThreadExtensionServiceShape {
  $setActivationStatus(extension: string, status: ExtensionHostStatus): Promise<void>;
}

export interface ExtHostExtensionServiceShape {
  $activateByEvent(event: string, skipExtension?: string): Promise<void>;
  $deltaExtensions(added: HostExtensionDescription[], removed: string[]): Promise<void>;
}

export const MainContext = {
  MainThreadCommands: createProxyIdentifier<MainThreadCommandsShape>('MainThreadCommands'),
  MainThreadExtensionService: createProxyIdentifier<MainThreadExtensionServiceShape>('MainThreadExtensionService'),
};

export const ExtHostContext = {
  ExtHostCommands: createProxyIdentifier<ExtHostCommandsShape>('ExtHostCommands'),
  ExtHostExtensionService: createProxyIdentifier<ExtHostExtensionServiceShape>('ExtHostExtensionService'),
};
