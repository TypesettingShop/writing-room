import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { validateExtensionManifest } from '../../../../platform/extensions/common/extensionValidator.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../platform/extensions/common/extensions.js';
import { resolveExtensionPath } from '../../extensions/common/extensionResources.js';

const manifests = import.meta.glob<unknown>('/extensions/*/package.json', { eager: true, import: 'default' });

export function scanBuiltinExtensions(): {
  extensions: IExtensionDescription[];
  messages: IExtensionMessage[];
} {
  const extensions: IExtensionDescription[] = [];
  const messages: IExtensionMessage[] = [];
  const application = new URL(import.meta.env.BASE_URL, document.baseURI);
  for (const [path, value] of Object.entries(manifests).sort(([a], [b]) => a.localeCompare(b))) {
    const folder = path.slice(0, path.lastIndexOf('/') + 1);
    const location = new URL(folder.slice(1), application).href;
    const { manifest, messages: diagnostics } = validateExtensionManifest(value, path => resolveExtensionPath(location, path));
    messages.push(...diagnostics);
    if (!manifest) {
      continue;
    }
    extensions.push({ identifier: ExtensionIdentifier.fromManifest(manifest), location, manifest, isBuiltin: true });
  }
  return { extensions, messages };
}
