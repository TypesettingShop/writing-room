import type { URI } from '../../../base/common/uri.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';
import type { WebviewForwardingPorts } from '../../contrib/webview/browser/webviewOrigin.js';

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

export interface MainThreadWebviewsShape {
  $createPanel(extension: string, handle: string, viewType: string, title: string, show: WebviewShowOptions,
    panelOptions: WebviewPanelOptions, contentOptions: WebviewContentOptions): Promise<void>;
  $setHtml(extension: string, handle: string, html: string): Promise<void>;
  $setOptions(extension: string, handle: string, options: WebviewContentOptions): Promise<void>;
  $postMessage(extension: string, handle: string, message: unknown): Promise<boolean>;
  $setTitle(extension: string, handle: string, title: string): Promise<void>;
  $setIcon(extension: string, handle: string, icon?: WebviewIcon): Promise<void>;
  $revealPanel(extension: string, handle: string, show: WebviewShowOptions): Promise<void>;
  $disposePanel(extension: string, handle: string): Promise<void>;
}

export interface ExtHostWebviewsShape {
  $getForwardingPorts(): Promise<WebviewForwardingPorts | undefined>;
  $onMessage(extension: string, handle: string, message: unknown): Promise<void>;
  $onPanelViewState(extension: string, handle: string, state: WebviewPanelViewState): Promise<void>;
  $onPanelDisposed(extension: string, handle: string): Promise<void>;
}

export const MainThreadWebviewsProxy = createProxyIdentifier<MainThreadWebviewsShape>('MainThreadWebviews');
export const ExtHostWebviewsProxy = createProxyIdentifier<ExtHostWebviewsShape>('ExtHostWebviews');
