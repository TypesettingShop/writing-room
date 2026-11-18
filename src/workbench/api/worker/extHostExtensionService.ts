import type * as vscode from 'vscode';
import { readResponseText } from '../../../base/parts/request/common/responseText.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { IExtensionModule } from '../common/extHostExtensionActivator.js';

const entryLimit = 5 * 1024 * 1024;
const fetchEntry = globalThis.fetch.bind(globalThis);
const evaluate = Function;

export async function loadCommonJSModule(
  extension: HostExtensionDescription, api: typeof vscode, signal: AbortSignal,
): Promise<IExtensionModule> {
  const response = await fetchEntry(extension.entry, {
    mode: 'cors', credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  const source = await readResponseText(response, entryLimit);
  signal.throwIfAborted();
  const module = { exports: {} as IExtensionModule };
  function require(name: string): typeof vscode {
    if (name === 'vscode') {
      return api;
    }
    throw new Error(`Cannot load module '${name}'`);
  }
  evaluate('module', 'exports', 'require', source + '\n//# sourceURL=' + encodeURI(extension.entry))(module, module.exports, require);
  return module.exports ?? {};
}
