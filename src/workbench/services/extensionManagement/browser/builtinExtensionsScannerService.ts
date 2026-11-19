import { readManifestNls } from '../../../../platform/extensionManagement/common/extensionNls.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { validateExtensionManifest } from '../../../../platform/extensions/common/extensionValidator.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../platform/extensions/common/extensions.js';
import { extensionResourceLimits, resolveExtensionPath } from '../../extensions/common/extensionResources.js';

const manifests = import.meta.glob<unknown>('/extensions/*/package.json', { eager: true, import: 'default' });

const manifestNls = import.meta.glob<string>('/extensions/*/package.nls.json', { eager: true, query: '?raw', import: 'default' });

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
    const identifier = ExtensionIdentifier.fromManifest(manifest);
    let nls: Record<string, string> | undefined;
    const text = manifestNls[folder + 'package.nls.json'];
    if (text !== undefined) {
      try {
        if (new TextEncoder().encode(text).byteLength > extensionResourceLimits.nls) {
          throw new Error('Localized manifest strings exceed 256 KiB.');
        }
        nls = readManifestNls(JSON.parse(text));
      } catch (error) {
        messages.push({ extensionId: identifier.value, path: 'package.nls.json', severity: 'warn', message: String(error) });
      }
    }
    extensions.push({ identifier, location, manifest, isBuiltin: true, nls });
  }
  return { extensions, messages };
}
