import { isRecord } from '../../extensions/common/extensionValidator.js';

export interface ProductConfiguration {
  readonly version: string;
  readonly extensionsGallery: {
    readonly serviceUrl: string;
    readonly allowedDownloadHosts: readonly string[];
  } | null;
  readonly webviewContentExternalBaseUrlTemplate?: string;
}

const defaultGallery: NonNullable<ProductConfiguration['extensionsGallery']> = {
  serviceUrl: 'https://open-vsx.org',
  allowedDownloadHosts: ['open-vsx.org', 'openvsx.eclipsecontent.org'],
};

const defaults: ProductConfiguration = { version: '1.148.0', extensionsGallery: defaultGallery };

export function parseExtensionGalleryUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  if (url.protocol === 'https:'
    || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
    return url;
  }
  return undefined;
}

function isHttpsUrl(value: unknown): value is string {
  try {
    const url = typeof value === 'string' ? new URL(value) : undefined;
    return Boolean(url?.protocol === 'https:' && !url.username && !url.password);
  } catch {
    return false;
  }
}

export function readProductConfiguration(json: string | undefined): ProductConfiguration {
  if (!json) {
    return defaults;
  }
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value)) {
      return defaults;
    }
    const { version, extensionsGallery, webviewContentExternalBaseUrlTemplate } = value;
    if (version !== undefined && (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))) {
      return defaults;
    }
    if (webviewContentExternalBaseUrlTemplate !== undefined
      && (typeof webviewContentExternalBaseUrlTemplate !== 'string'
        || !isHttpsUrl(webviewContentExternalBaseUrlTemplate.replace(/\{[^}]+\}/g, 'placeholder')))) {
      return defaults;
    }
    const gallery = { ...defaultGallery };
    if (extensionsGallery !== undefined && extensionsGallery !== null) {
      if (!isRecord(extensionsGallery)) {
        return defaults;
      }
      const { serviceUrl, allowedDownloadHosts } = extensionsGallery;
      if (serviceUrl !== undefined) {
        if (typeof serviceUrl !== 'string' || !parseExtensionGalleryUrl(serviceUrl)) {
          return defaults;
        }
        gallery.serviceUrl = serviceUrl;
      }
      if (allowedDownloadHosts !== undefined) {
        if (!Array.isArray(allowedDownloadHosts)
          || !allowedDownloadHosts.every(host => typeof host === 'string' && /^[a-z\d-]+(?:\.[a-z\d-]+)*$/i.test(host))) {
          return defaults;
        }
        gallery.allowedDownloadHosts = allowedDownloadHosts.map(host => host.toLowerCase());
      }
    }
    return {
      version: version ?? defaults.version,
      extensionsGallery: extensionsGallery === null ? null : gallery,
      webviewContentExternalBaseUrlTemplate,
    };
  } catch {
    return defaults;
  }
}

const env = (import.meta as ImportMeta & { env?: { VITE_WRITING_ROOM_PRODUCT?: string } }).env;
export const product = readProductConfiguration(env?.VITE_WRITING_ROOM_PRODUCT);
