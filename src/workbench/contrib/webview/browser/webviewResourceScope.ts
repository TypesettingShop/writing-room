import { isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { WebviewContentOptions } from '../../../api/common/extHost.protocol.webview.js';
import { normalizeWebviewResource } from './resourceLoading.js';

export function scopeWebviewOptions(
  extensionLocation: string, workspaceFolders: readonly URI[], options: WebviewContentOptions,
): WebviewContentOptions {
  const roots = [...workspaceFolders, URI.parse(extensionLocation)]
    .map(normalizeWebviewResource).filter(root => root !== undefined);
  const requested = Array.isArray(options.localResourceRoots) ? options.localResourceRoots : roots;
  return {
    enableScripts: options.enableScripts === true,
    enableForms: typeof options.enableForms === 'boolean' ? options.enableForms : undefined,
    localResourceRoots: requested.filter(URI.isUri).map(normalizeWebviewResource).filter(
      (root): root is URI => root !== undefined && roots.some(scope => isEqualOrParent(root, scope))),
  };
}
