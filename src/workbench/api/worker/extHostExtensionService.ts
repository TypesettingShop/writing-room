import type * as vscode from 'vscode';
import { fetchBoundedResource } from '../../../base/parts/request/common/boundedFetch.js';
import { extensionResourceLimits } from '../../services/extensions/common/extensionResources.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { IExtensionModule } from '../common/extHostExtensionActivator.js';

const fetchEntry = globalThis.fetch.bind(globalThis);
const evaluate = Function;

export async function loadCommonJSModule(
  extension: HostExtensionDescription, api: typeof vscode, signal: AbortSignal,
): Promise<IExtensionModule> {
  const { bytes } = await fetchBoundedResource(extension.entry, {
    limit: extensionResourceLimits.entry, signal, request: fetchEntry,
  });
  const source = new TextDecoder().decode(bytes);
  signal.throwIfAborted();
  const module = { exports: {} as IExtensionModule };
  function require(name: string): typeof vscode {
    if (name === 'vscode') {
      return api;
    }
    throw new Error(`Cannot load module '${name}'`);
  }
  evaluate('module', 'exports', 'require', source + '\n//# sourceURL=' + extension.entry)(module, module.exports, require);
  return module.exports ?? {};
}
