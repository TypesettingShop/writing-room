import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { URI } from '../../../base/common/uri.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';
import type { WebviewOrigin } from '../../contrib/webview/common/webviewOrigin.js';
import type {
  MainThreadWebviewContent, WebviewContentOptions, WebviewPanelOptions, WebviewPanelViewState, WebviewShowOptions,
} from './extHost.protocol.webview.js';

/** What the extension host needs to hand a custom text editor to its provider. */
export interface CustomTextEditorResolveData {
  readonly viewType: string;
  readonly resource: URI;
  /** The id of the text document, which the main thread mirrored before sending this. */
  readonly documentId: string;
  readonly title: string;
  readonly options: WebviewPanelOptions;
  readonly contentOptions: WebviewContentOptions;
  readonly viewState: WebviewPanelViewState;
}

/**
 * Custom editors in the main thread. Every call names the extension that makes it; a handle names one
 * resolved editor (its Webview) and belongs to the extension it was resolved for.
 */
export interface MainThreadCustomEditorsShape extends MainThreadWebviewContent {
  $registerTextEditorProvider(extension: string, viewType: string, options: WebviewPanelOptions,
    supportsMultipleEditorsPerDocument: boolean): Promise<void>;
  $unregisterProvider(extension: string, viewType: string): Promise<void>;
  $reveal(extension: string, handle: string, show: WebviewShowOptions): Promise<void>;
  /** The extension disposed the panel: the editor closes. */
  $disposeEditor(extension: string, handle: string): Promise<void>;
}

export interface ExtHostCustomEditorsShape {
  /** Calls the provider's `resolveCustomTextEditor`; it rejects when the provider threw. */
  $resolveTextEditor(extension: string, handle: string, data: CustomTextEditorResolveData, origin: WebviewOrigin,
    token: CancellationToken): Promise<void>;
  $onMessage(extension: string, handle: string, message: unknown): Promise<void>;
  $onViewState(extension: string, handle: string, state: WebviewPanelViewState): Promise<void>;
  /** The editor closed, or its extension host is going: the panel fires `onDidDispose` once. */
  $onDisposed(extension: string, handle: string): Promise<void>;
}

export const MainThreadCustomEditorsProxy = createProxyIdentifier<MainThreadCustomEditorsShape>('MainThreadCustomEditors');
export const ExtHostCustomEditorsProxy = createProxyIdentifier<ExtHostCustomEditorsShape>('ExtHostCustomEditors');
