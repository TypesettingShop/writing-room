import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

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

export const MainThreadTreeViewsProxy = createProxyIdentifier<MainThreadTreeViewsShape>('MainThreadTreeViews');
export const ExtHostTreeViewsProxy = createProxyIdentifier<ExtHostTreeViewsShape>('ExtHostTreeViews');
