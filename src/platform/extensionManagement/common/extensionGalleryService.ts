import { fetchBoundedResource, ResourceRequestError, ResourceResponseError } from '../../../base/parts/request/common/boundedFetch.js';
import { isRecord } from '../../extensions/common/extensionValidator.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { ProductConfiguration } from '../../product/common/product.js';
import { vsixLimits } from './extensionManagementUtil.js';
import { sha256Hex, signatureBundleLimit, verifyExtensionSignature } from './extensionSignature.js';
import type { ExtensionSignature } from './extensionSignature.js';

export const IExtensionGalleryService = createDecorator<ExtensionGalleryService>('extensionGalleryService');
export const galleryPageSize = 20;
export const galleryQueryLimit = 256;
const responseLimit = 1024 * 1024;
const iconLimit = 256 * 1024;
const keyLimit = 4096;
const rateLimitPause = 60_000;

export interface GalleryIdentifier {
  readonly namespace: string;
  readonly name: string;
}

export interface GalleryExtension extends GalleryIdentifier {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly downloadCount: number;
  readonly verifiedPublisher: boolean;
  readonly icon?: string;
}

export interface GallerySearchPage {
  readonly extensions: readonly GalleryExtension[];
  readonly nextOffset?: number;
}

export interface GalleryExtensionVersion extends GalleryExtension {
  readonly license?: string;
  readonly isWebExtension: boolean;
  readonly dependencies: readonly GalleryIdentifier[];
  readonly hasExtensionPack: boolean;
  readonly download: string;
  readonly sha256: string;
  readonly signature?: { readonly bundle: string; readonly publicKey: string; readonly keyId: string };
}

export interface GalleryDownload {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly sha256: string;
  readonly signature: ExtensionSignature;
  readonly host: string;
}

export class GalleryRateLimitError extends Error {
  constructor() {
    super('Open VSX is rate limited. Try again in a minute.');
  }
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
}

function identifierPart(value: unknown): value is string {
  return text(value, 128) && /^[a-z\d][a-z\d-]*$/i.test(value);
}

function versionPart(value: unknown): value is string {
  return text(value, 128) && /^\d+\.\d+\.\d+(?:-[a-z\d.-]+)?(?:\+[a-z\d.-]+)?$/i.test(value);
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function galleryId({ namespace, name }: GalleryIdentifier): string {
  return (namespace + '.' + name).toLowerCase();
}

function dependencyIds(value: unknown): GalleryIdentifier[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('Open VSX returned invalid extension dependencies.');
  }
  return value.map((dependency: unknown) => {
    if (!isRecord(dependency) || !identifierPart(dependency.namespace) || !identifierPart(dependency.extension)) {
      throw new Error('Open VSX returned an invalid extension dependency.');
    }
    return { namespace: dependency.namespace, name: dependency.extension };
  });
}

export class ExtensionGalleryService {
  declare readonly _serviceBrand: undefined;
  private readonly base: URL | undefined;
  private readonly hosts: readonly string[];
  private blockedUntil = 0;

  constructor(
    configuration: ProductConfiguration['extensionsGallery'] | undefined,
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
  ) {
    if (configuration?.serviceUrl && URL.canParse(configuration.serviceUrl)) {
      const base = new URL(configuration.serviceUrl);
      if (!base.username && !base.password && !base.search && !base.hash
        && (base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)))) {
        base.pathname = base.pathname.replace(/\/+$/, '') + '/';
        this.base = base;
      }
    }
    this.hosts = configuration?.allowedDownloadHosts ?? [];
  }

  get enabled(): boolean {
    return this.base !== undefined;
  }

  get rateLimited(): boolean {
    return Date.now() < this.blockedUntil;
  }

  async search(query: string, offset = 0, signal?: AbortSignal): Promise<GallerySearchPage> {
    if (!count(offset)) {
      throw new Error('Invalid Open VSX search offset.');
    }
    const url = this.api('-/search');
    url.search = new URLSearchParams({ query: query.trim().slice(0, galleryQueryLimit), size: String(galleryPageSize), offset: String(offset) }).toString();
    const result = await this.json(url, signal);
    if (!isRecord(result) || !count(result.totalSize) || result.offset !== offset || !Array.isArray(result.extensions)) {
      throw new Error('Open VSX returned an invalid search response.');
    }
    const extensions = result.extensions.slice(0, galleryPageSize).flatMap((entry: unknown) => {
      const extension = this.summary(entry);
      return extension ? [extension] : [];
    });
    const nextOffset = offset + galleryPageSize;
    return {
      extensions,
      ...(result.extensions.length >= galleryPageSize && Number.isSafeInteger(nextOffset) && nextOffset < result.totalSize
        ? { nextOffset } : {}),
    };
  }

  async getExtension(identifier: GalleryIdentifier, version?: string, signal?: AbortSignal): Promise<GalleryExtensionVersion> {
    const { namespace, name } = identifier;
    if (!identifierPart(namespace) || !identifierPart(name) || (version !== undefined && !versionPart(version))) {
      throw new Error('Invalid Open VSX extension identifier or version.');
    }
    const path = [namespace, name, ...(version ? [version] : [])].map(encodeURIComponent).join('/');
    const result = await this.json(this.api(path), signal);
    const summary = this.summary(result);
    if (!isRecord(result) || !summary || summary.id !== galleryId(identifier) || (version && summary.version !== version)
      || !Array.isArray(result.extensionKind) || result.extensionKind.length > 3
      || !result.extensionKind.every(kind => kind === 'ui' || kind === 'workspace' || kind === 'web')
      || (result.license != null && !text(result.license, 512)) || !isRecord(result.files)
      || (result.bundledExtensions !== undefined && !Array.isArray(result.bundledExtensions))) {
      throw new Error('Open VSX returned invalid extension metadata.');
    }
    const download = this.assetUrl(result.files.download);
    const sha256 = this.assetUrl(result.files.sha256);
    if (!download || !sha256) {
      throw new Error('Open VSX did not provide a package download and SHA-256 checksum.');
    }
    let signature: GalleryExtensionVersion['signature'];
    if (result.files.signature !== undefined || result.files.publicKey !== undefined) {
      const bundle = this.assetUrl(result.files.signature);
      const publicKey = this.assetUrl(result.files.publicKey);
      const keyPrefix = this.api('-/public-key/').pathname;
      const keyPath = publicKey?.pathname;
      const keyId = keyPath?.startsWith(keyPrefix) && keyPath.slice(keyPrefix.length);
      if (!bundle || !publicKey || !identifierPart(keyId)) {
        throw new Error('Open VSX returned incomplete or invalid signature metadata.');
      }
      signature = { bundle: bundle.href, publicKey: publicKey.href, keyId };
    }
    const size = isRecord(result.downloadSizes) && typeof result.targetPlatform === 'string'
      ? result.downloadSizes[result.targetPlatform] : undefined;
    if (count(size) && size > vsixLimits.download) {
      throw new Error('The Open VSX package exceeds the 50 MiB download limit.');
    }
    return {
      ...summary,
      ...(typeof result.license === 'string' ? { license: result.license } : {}),
      isWebExtension: result.extensionKind.includes('web'),
      dependencies: dependencyIds(result.dependencies), hasExtensionPack: Boolean(result.bundledExtensions?.length),
      download: download.href, sha256: sha256.href, ...(signature ? { signature } : {}),
    };
  }

  async download(extension: GalleryExtensionVersion, signal?: AbortSignal): Promise<GalleryDownload> {
    if (!extension.isWebExtension) {
      throw new Error('This Open VSX extension is not a web extension.');
    }
    if (extension.hasExtensionPack) {
      throw new Error('Open VSX extension packs are not supported.');
    }
    const pkg = await this.downloadAsset(extension.download, vsixLimits.download, signal, true);
    const checksum = await this.downloadAsset(extension.sha256, 1024, signal);
    const expected = new TextDecoder().decode(checksum.bytes).trim().toLowerCase();
    const sha256 = await sha256Hex(pkg.bytes);
    signal?.throwIfAborted();
    if (!/^[a-f\d]{64}$/.test(expected) || sha256 !== expected) {
      throw new Error('The Open VSX SHA-256 checksum does not match the downloaded package.');
    }
    let signature: ExtensionSignature = { state: 'unsigned' };
    if (extension.signature) {
      const { bundle, publicKey, keyId } = extension.signature;
      const signatures = await this.downloadAsset(bundle, signatureBundleLimit, signal);
      const key = await this.read(this.requireAsset(publicKey), keyLimit, signal);
      signature = await verifyExtensionSignature(pkg.bytes, signatures.bytes, key.bytes, keyId, signal);
    }
    return { bytes: pkg.bytes, sha256, signature, host: new URL(pkg.url).host };
  }

  async fetchIcon(value: string, signal: AbortSignal): Promise<Blob> {
    const icon = await this.downloadAsset(value, iconLimit, signal, false, 'image/');
    return new Blob([icon.bytes], { type: icon.contentType });
  }

  private summary(input: unknown): GalleryExtension | undefined {
    if (!isRecord(input) || !identifierPart(input.namespace) || !identifierPart(input.name) || !versionPart(input.version)
      || (input.displayName != null && !text(input.displayName, 256))
      || (input.description != null && !text(input.description, 4096))
      || (input.downloadCount !== undefined && !count(input.downloadCount))
      || (input.verified !== undefined && typeof input.verified !== 'boolean')) {
      return undefined;
    }
    const identifier = { namespace: input.namespace, name: input.name };
    const icon = isRecord(input.files) ? this.assetUrl(input.files.icon)?.href : undefined;
    return {
      ...identifier, id: galleryId(identifier), version: input.version,
      displayName: input.displayName || input.name, description: input.description ?? '',
      downloadCount: input.downloadCount ?? 0, verifiedPublisher: input.verified === true, ...(icon ? { icon } : {}),
    };
  }

  private api(path: string): URL {
    if (!this.base) {
      throw new Error('Open VSX is unavailable.');
    }
    return new URL('api/' + path, this.base);
  }

  private assetUrl(value: unknown): URL | undefined {
    if (!this.base || !text(value, 2048) || !value) {
      return undefined;
    }
    try {
      const url = new URL(value);
      return url.origin === this.base.origin && url.pathname.startsWith(this.api('').pathname)
        && !url.username && !url.password && !url.search && !url.hash ? url : undefined;
    } catch {
      return undefined;
    }
  }

  private requireAsset(value: string): URL {
    const url = this.assetUrl(value);
    if (!url) {
      throw new Error('Open VSX returned an unapproved asset URL.');
    }
    return url;
  }

  private async json(url: URL, signal?: AbortSignal): Promise<unknown> {
    const { bytes } = await this.read(url, responseLimit, signal);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Error('Open VSX returned invalid JSON.');
    }
  }

  private downloadAsset(value: string, limit: number, signal?: AbortSignal, idleTimeout?: boolean, contentTypePrefix?: string) {
    return this.read(this.requireAsset(value), limit, signal, this.hosts, idleTimeout, contentTypePrefix);
  }

  private async read(url: URL, limit: number, signal?: AbortSignal,
    redirectHosts?: readonly string[], idleTimeout?: boolean, contentTypePrefix?: string) {
    signal?.throwIfAborted();
    if (this.rateLimited) {
      throw new GalleryRateLimitError();
    }
    try {
      const response = await fetchBoundedResource(url, {
        limit, signal, redirectHosts, idleTimeout, contentTypePrefix,
        request: (input, init) => this.request(input, { ...init, referrerPolicy: 'no-referrer' }),
      });
      if (response.headers.get('X-RateLimit-Remaining')?.trim() === '0') {
        this.blockedUntil = Date.now() + rateLimitPause;
      }
      return response;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ResourceResponseError && error.status === 429) {
        this.blockedUntil = Date.now() + rateLimitPause;
        throw new GalleryRateLimitError();
      }
      if (error instanceof ResourceRequestError && error.cause) {
        throw new Error('Could not connect to Open VSX.', { cause: error });
      }
      throw error;
    }
  }
}
