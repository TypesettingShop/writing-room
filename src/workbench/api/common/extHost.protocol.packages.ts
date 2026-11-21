import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

export interface MainThreadExtensionResourcesShape {
  /** Reads the `browser` entry of an extension installed as a package, by its `vscode-userdata` URI. */
  $readPackageEntry(entry: string): Promise<Uint8Array>;
}

export const MainThreadExtensionResourcesProxy = createProxyIdentifier<MainThreadExtensionResourcesShape>('MainThreadExtensionResources');
