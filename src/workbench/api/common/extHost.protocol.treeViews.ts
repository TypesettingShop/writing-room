import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { URI } from '../../../base/common/uri.js';
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

/** A product icon by codicon name, or an image the extension can read, one for each kind of theme. */
export type TreeItemIconDto =
  | { readonly kind: 'theme'; readonly id: string; readonly color?: string }
  | { readonly kind: 'uri'; readonly light: URI; readonly dark: URI };

export interface AccessibilityInformationDto {
  readonly label: string;
  readonly role?: string;
}

export interface TreeItemCheckboxDto {
  readonly checked: boolean;
  readonly tooltip?: string;
  readonly accessibilityInformation?: AccessibilityInformationDto;
}

export interface TreeItemDto {
  readonly handle: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly collapsible: 0 | 1 | 2;
  readonly contextValue?: string;
  readonly command?: CommandDto;
  readonly icon?: TreeItemIconDto;
  readonly accessibilityInformation?: AccessibilityInformationDto;
  readonly checkbox?: TreeItemCheckboxDto;
  /** The provider can fill the tooltip in later: the workbench asks with `$resolveTreeItem` on hover. */
  readonly resolvable?: boolean;
}

export interface TreeViewOptionsDto {
  readonly showCollapseAll: boolean;
  readonly canSelectMany: boolean;
  readonly manageCheckboxStateManually: boolean;
  readonly dropMimeTypes: readonly string[];
  readonly dragMimeTypes: readonly string[];
  readonly hasHandleDrag: boolean;
  readonly hasHandleDrop: boolean;
}

export interface TreeRevealOptionsDto {
  readonly select: boolean;
  readonly focus: boolean;
  /** How many levels below the element to expand, 0 to 3. */
  readonly expand: number;
}

export interface ViewBadgeDto {
  readonly value: number;
  readonly tooltip: string;
}

/** One item of a drag: a string, or a file the user dragged in from the operating system. */
export interface DataTransferItemDto {
  readonly mimeType: string;
  readonly value: string;
  readonly file?: {
    readonly name: string;
    /** Absent when the file is over the size limit: reading it then fails. */
    readonly data?: Uint8Array;
  };
}

export interface MainThreadTreeViewsShape {
  $registerTreeViewDataProvider(extension: string, view: string, options?: TreeViewOptionsDto): Promise<void>;
  $refresh(extension: string, view: string, handles?: string[]): Promise<void>;
  $disposeTree(extension: string, view: string): Promise<void>;
  /** Shows `chain`'s last handle; the handles before it are its ancestors from the root down. */
  $reveal(extension: string, view: string, chain: string[], options: TreeRevealOptionsDto): Promise<void>;
  $setMessage(extension: string, view: string, message: string): Promise<void>;
  $setTitle(extension: string, view: string, title: string | undefined, description: string | undefined): Promise<void>;
  $setBadge(extension: string, view: string, badge: ViewBadgeDto | undefined): Promise<void>;
}

export interface ExtHostTreeViewsShape {
  $getTreeItem(extension: string, view: string, handle: string): Promise<TreeItemDto | undefined>;
  $getChildren(extension: string, view: string, parent?: string): Promise<TreeItemDto[]>;
  $resolveTreeItem(extension: string, view: string, handle: string, token?: CancellationToken): Promise<string | undefined>;
  $setSelection(extension: string, view: string, handles: string[]): Promise<void>;
  $setExpanded(extension: string, view: string, handle: string, expanded: boolean): Promise<void>;
  $setVisible(extension: string, view: string, visible: boolean): Promise<void>;
  $changeCheckboxState(extension: string, view: string, items: [handle: string, checked: boolean][]): Promise<void>;
  /** Asks the source tree for its drag data; the values stay in the host under `drag` for a drop in the same extension. */
  $handleDrag(extension: string, view: string, handles: string[], drag: string, token?: CancellationToken): Promise<DataTransferItemDto[]>;
  $handleDrop(extension: string, view: string, target: string | undefined, items: DataTransferItemDto[], drag: string | undefined,
    token?: CancellationToken): Promise<void>;
  $releaseDrag(extension: string, drag: string): Promise<void>;
}

export const MainThreadTreeViewsProxy = createProxyIdentifier<MainThreadTreeViewsShape>('MainThreadTreeViews');
export const ExtHostTreeViewsProxy = createProxyIdentifier<ExtHostTreeViewsShape>('ExtHostTreeViews');
