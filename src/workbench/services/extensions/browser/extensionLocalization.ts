import { localeFallbacks, readManifestNls } from '../../../../platform/extensionManagement/common/extensionNls.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { URI } from '../../../../base/common/uri.js';
import { extensionResourceLimits, resolveExtensionResource } from '../common/extensionResources.js';
import type { HostExtensionDescription } from '../common/extensionHostProtocol.js';

export async function loadLocaleManifest(
  files: IFileService, extension: IExtensionDescription, locale: string, signal: AbortSignal,
): Promise<Readonly<Record<string, string>> | undefined> {
  const { identifier: { value: id }, location, manifest } = extension;
  if (!/%[^"%]+%/.test(JSON.stringify(manifest))) {
    return undefined;
  }
  const tables = await Promise.all(localeFallbacks(locale).filter(language => language !== 'en').map(async language => {
    const filename = `package.nls.${language}.json`;
    const file = resolveExtensionResource(URI.parse(location), filename);
    if (!file || signal.aborted) {
      return undefined;
    }
    try {
      const { value } = await files.readFile(file, { limits: { size: extensionResourceLimits.nls }, signal });
      return readManifestNls(JSON.parse(new TextDecoder().decode(value)));
    } catch (error) {
      if (!signal.aborted && toFileSystemProviderErrorCode(error) !== FileSystemProviderErrorCode.FileNotFound) {
        console.warn(`[${id}] Could not read ${filename}:`, error);
      }
      return undefined;
    }
  }));
  return tables.some(table => table && Object.keys(table).length) ? Object.assign(Object.create(null), extension.nls, ...tables) : undefined;
}

export async function loadExtensionBundle(
  files: IFileService, extension: HostExtensionDescription,
): Promise<{ json: string; uri: string } | undefined> {
  const { id, location, manifest, runtime } = extension;
  if (typeof manifest.l10n !== 'string') {
    return undefined;
  }
  const locale = runtime?.locale ?? 'en';
  for (const language of localeFallbacks(locale).reverse()) {
    const file = resolveExtensionResource(URI.parse(location), manifest.l10n + '/bundle.l10n.' + language + '.json');
    if (!file) {
      console.warn(`[${id}] The l10n directory must be inside the extension folder.`);
      return undefined;
    }
    try {
      const { value } = await files.readFile(file, { limits: { size: extensionResourceLimits.resource } });
      const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
        || !Object.values(parsed).every(message => typeof message === 'string')) {
        throw new TypeError('Expected a bundle of strings.');
      }
      return { json: JSON.stringify(parsed), uri: file.toString() };
    } catch (error) {
      if (toFileSystemProviderErrorCode(error) !== FileSystemProviderErrorCode.FileNotFound) {
        console.warn(`[${id}] Could not read the ${language} l10n bundle:`, error);
      }
    }
  }
  return undefined;
}
