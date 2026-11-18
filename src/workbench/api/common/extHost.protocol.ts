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

export interface CommandDto {
  readonly id: string;
  readonly args?: unknown[];
}

export interface TreeItemReference {
  readonly kind: 'extensionTreeItem';
  readonly extension: string;
  readonly view: string;
  readonly handle: string;
}

export interface TreeItemDto {
  readonly handle: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly collapsible: 0 | 1 | 2;
  readonly contextValue?: string;
  readonly command?: CommandDto;
}

export interface MainThreadTreeViewsShape {
  $registerTreeViewDataProvider(extension: string, view: string): Promise<void>;
  $refresh(extension: string, view: string, handles?: string[]): Promise<void>;
  $disposeTree(extension: string, view: string): Promise<void>;
}

export interface ExtHostTreeViewsShape {
  $getTreeItem(extension: string, view: string, handle: string): Promise<TreeItemDto | undefined>;
  $getChildren(extension: string, view: string, parent?: string): Promise<TreeItemDto[]>;
}

export interface StatusBarEntryDto {
  readonly text: string;
  readonly name?: string;
  readonly tooltip?: string;
  readonly command?: string | CommandDto;
  readonly alignment: 1 | 2;
  readonly priority?: number;
}

export interface MainThreadStatusBarShape {
  $setEntry(extension: string, id: string, entry: StatusBarEntryDto): Promise<void>;
  $disposeEntry(extension: string, id: string): Promise<void>;
}

export type MessageSeverity = 'info' | 'warning' | 'error';

export interface MainThreadMessageServiceShape {
  $showMessage(extension: string, severity: MessageSeverity, message: string, actions: string[]): Promise<number | undefined>;
}

export const MainContext = {
  MainThreadTreeViews: createProxyIdentifier<MainThreadTreeViewsShape>('MainThreadTreeViews'),
  MainThreadStatusBar: createProxyIdentifier<MainThreadStatusBarShape>('MainThreadStatusBar'),
  MainThreadMessageService: createProxyIdentifier<MainThreadMessageServiceShape>('MainThreadMessageService'),
  MainThreadCommands: createProxyIdentifier<MainThreadCommandsShape>('MainThreadCommands'),
  MainThreadExtensionService: createProxyIdentifier<MainThreadExtensionServiceShape>('MainThreadExtensionService'),
};

export const ExtHostContext = {
  ExtHostTreeViews: createProxyIdentifier<ExtHostTreeViewsShape>('ExtHostTreeViews'),
  ExtHostCommands: createProxyIdentifier<ExtHostCommandsShape>('ExtHostCommands'),
  ExtHostExtensionService: createProxyIdentifier<ExtHostExtensionServiceShape>('ExtHostExtensionService'),
};
