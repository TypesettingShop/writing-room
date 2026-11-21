import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

export interface MainThreadCommandsShape {
  $registerCommand(extension: string, id: string): Promise<void>;
  $unregisterCommand(extension: string, id: string): Promise<void>;
  $executeCommand(extension: string, id: string, args: unknown[]): Promise<unknown>;
}

export interface ExtHostCommandsShape {
  $executeContributedCommand(extension: string, id: string, args: unknown[]): Promise<unknown>;
}

export const MainThreadCommandsProxy = createProxyIdentifier<MainThreadCommandsShape>('MainThreadCommands');
export const ExtHostCommandsProxy = createProxyIdentifier<ExtHostCommandsShape>('ExtHostCommands');
