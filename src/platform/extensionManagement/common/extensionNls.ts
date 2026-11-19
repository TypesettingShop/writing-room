import type { IExtensionManifest } from '../../extensions/common/extensions.js';

const placeholder = /^%([^%]+)%$/;
const displayFields = new Set([
  'title', 'shortTitle', 'category', 'displayName', 'description', 'markdownDescription', 'detail', 'label', 'name',
  'enumDescriptions', 'markdownEnumDescriptions', 'deprecationMessage', 'markdownDeprecationMessage', 'message',
  'contents', 'display', 'placeholder',
]);

export function readManifestNls(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Expected a localized manifest object.');
  }
  const translations: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      translations[key] = value;
    } else if (value && typeof value === 'object' && typeof value.message === 'string') {
      translations[key] = value.message;
    }
  }
  return translations;
}

export function localizeManifest(
  manifest: IExtensionManifest, translations: Readonly<Record<string, unknown>> | undefined,
): IExtensionManifest {
  if (!translations) {
    return manifest;
  }
  const strings = readManifestNls(translations);
  const visit = (value: unknown, field?: string, depth = 0): unknown => {
    if (typeof value === 'string' && field && displayFields.has(field) && !(depth === 1 && field === 'name')) {
      const key = placeholder.exec(value)?.[1];
      return key !== undefined && Object.hasOwn(strings, key) ? strings[key] : value;
    }
    if (Array.isArray(value)) {
      return value.map(entry => visit(entry, field, depth + 1));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key, key === 'configurationDefaults' ? entry : visit(entry, key, depth + 1),
      ]));
    }
    return value;
  };
  return visit(manifest) as IExtensionManifest;
}

export function localeFallbacks(locale: string): string[] {
  const parts = locale.split('-');
  return parts.map((_, index) => parts.slice(0, index + 1).join('-'));
}
