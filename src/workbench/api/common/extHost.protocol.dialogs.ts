import type { URI } from '../../../base/common/uri.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

/** The options an extension passed, as they cross: `defaultUri` travels as a URI. */
export interface MainThreadDialogOpenOptions {
  readonly defaultUri?: URI;
  readonly openLabel?: string;
  readonly canSelectFiles?: boolean;
  readonly canSelectFolders?: boolean;
  readonly canSelectMany?: boolean;
  readonly filters?: { readonly [name: string]: readonly string[] };
  readonly title?: string;
}

export interface MainThreadDialogSaveOptions {
  readonly defaultUri?: URI;
  readonly saveLabel?: string;
  readonly filters?: { readonly [name: string]: readonly string[] };
  readonly title?: string;
}

export interface MainThreadDialogsShape {
  $showOpenDialog(extension: string, options?: MainThreadDialogOpenOptions): Promise<URI[] | undefined>;
  $showSaveDialog(extension: string, options?: MainThreadDialogSaveOptions): Promise<URI | undefined>;
}

export const MainThreadDialogsProxy = createProxyIdentifier<MainThreadDialogsShape>('MainThreadDialogs');
