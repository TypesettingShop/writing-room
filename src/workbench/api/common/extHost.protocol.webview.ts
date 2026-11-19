import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { URI } from '../../../base/common/uri.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';
import type { WebviewForwardingPorts, WebviewOrigin } from '../../contrib/webview/common/webviewOrigin.js';

export interface WebviewContentOptions {
  readonly enableScripts?: boolean;
  readonly enableForms?: boolean;
  readonly localResourceRoots?: readonly URI[];
}

export interface WebviewPanelOptions {
  readonly enableFindWidget?: boolean;
  readonly retainContextWhenHidden?: boolean;
}

export interface WebviewShowOptions {
  readonly viewColumn?: number;
  readonly preserveFocus?: boolean;
}

export interface WebviewPanelViewState {
  readonly active: boolean;
  readonly visible: boolean;
  readonly viewColumn?: number;
}

export type WebviewIcon = URI | {
  readonly light: URI;
  readonly dark: URI;
} | {
  readonly id: string;
  readonly color?: { readonly id: string };
};

export interface WebviewPanelRestoreData {
  readonly id: string;
  readonly viewType: string;
  readonly title: string;
  readonly options: WebviewPanelOptions;
  readonly contentOptions: WebviewContentOptions;
  readonly viewState: WebviewPanelViewState;
  readonly icon?: WebviewIcon;
  readonly state: unknown;
}

export interface MainThreadWebviewsShape {
  $getForwardingHint(): Promise<WebviewForwardingPorts | undefined>;
  $createPanel(extension: string, handle: string, viewType: string, title: string, show: WebviewShowOptions,
    panelOptions: WebviewPanelOptions, contentOptions: WebviewContentOptions): Promise<void>;
  $setHtml(extension: string, handle: string, html: string): Promise<void>;
  $setOptions(extension: string, handle: string, options: WebviewContentOptions): Promise<void>;
  $postMessage(extension: string, handle: string, message: unknown): Promise<boolean>;
  $setTitle(extension: string, handle: string, title: string): Promise<void>;
  $setIcon(extension: string, handle: string, icon?: WebviewIcon): Promise<void>;
  $revealPanel(extension: string, handle: string, show: WebviewShowOptions): Promise<void>;
  $registerPanelSerializer(extension: string, viewType: string): Promise<void>;
  $unregisterPanelSerializer(extension: string, viewType: string): Promise<void>;
  $disposePanel(extension: string, handle: string): Promise<void>;
}

export interface ExtHostWebviewsShape {
  $onMessage(extension: string, handle: string, message: unknown): Promise<void>;
  $onPanelViewState(extension: string, handle: string, state: WebviewPanelViewState): Promise<void>;
  $deserializePanel(extension: string, handle: string, data: WebviewPanelRestoreData, origin: WebviewOrigin, token: CancellationToken): Promise<void>;
  $onPanelDisposed(extension: string, handle: string): Promise<void>;
}

export type MainThreadWebviewContent = Pick<MainThreadWebviewsShape, '$setHtml' | '$setOptions' | '$postMessage'>;

export interface MainThreadWebviewViewsShape extends MainThreadWebviewContent {
  $registerProvider(extension: string, viewId: string, retainContextWhenHidden: boolean): Promise<void>;
  $unregisterProvider(extension: string, viewId: string): Promise<void>;
  $setViewLabel(extension: string, handle: string, label: 'title' | 'description', value: string | undefined): Promise<void>;
  $showView(extension: string, handle: string, preserveFocus: boolean): Promise<void>;
}

export interface ExtHostWebviewViewsShape {
  $resolveView(extension: string, handle: string, viewId: string, title: string, state: unknown, visible: boolean,
    origin: WebviewOrigin, token: CancellationToken): Promise<void>;
  $onViewMessage(extension: string, handle: string, value: unknown): Promise<void>;
  $onViewVisibility(extension: string, handle: string, visible: boolean): Promise<void>;
  $onViewDisposed(extension: string, handle: string): Promise<void>;
}

export const MainThreadWebviewViewsProxy = createProxyIdentifier<MainThreadWebviewViewsShape>('MainThreadWebviewViews');
export const ExtHostWebviewViewsProxy = createProxyIdentifier<ExtHostWebviewViewsShape>('ExtHostWebviewViews');

export const MainThreadWebviewsProxy = createProxyIdentifier<MainThreadWebviewsShape>('MainThreadWebviews');
export const ExtHostWebviewsProxy = createProxyIdentifier<ExtHostWebviewsShape>('ExtHostWebviews');
