import type * as vscode from 'vscode';
import '../common/extHostEntryReaders.js';
import { URI } from '../../../base/common/uri.js';
import { readExtensionEntry } from '../../services/extensions/common/extensionResources.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { IExtensionModule } from '../common/extHostExtensionActivator.js';

const evaluate = Function;

export async function loadCommonJSModule(
  extension: HostExtensionDescription, api: typeof vscode, signal: AbortSignal,
): Promise<IExtensionModule> {
  const bytes = await readExtensionEntry(URI.parse(extension.entry), signal);
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
