import { Disposable } from '../../../base/common/lifecycle.js';
import { isEqualOrParent, normalizePath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import type { IFileService } from '../../../platform/files/common/files.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';

const maxBlob = 64 * 1024 * 1024;
const maxOwnerBytes = 256 * 1024 * 1024;
const mediaTypes: Readonly<Record<string, string>> = {
  css: 'text/css', svg: 'image/svg+xml', json: 'application/json', js: 'text/javascript',
  txt: 'text/plain', html: 'text/html', wasm: 'application/wasm',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

export function extensionResourceUri(value: string, folders: readonly string[]): URI | undefined {
  try {
    const resource = URI.parse(value, true);
    if (resource.hasEncodedPathSeparator || resource.query || resource.fragment
      || /[\\\x00-\x1f\x7f]|%(?:25)*(?:2e|2f|5c)/i.test(resource.path) || resource.authority.includes('@')) {
      return undefined;
    }
    const normalized = normalizePath(resource);
    const allowed = folders.some(folder => {
      const parent = URI.parse(folder, true);
      return parent.path.endsWith('/') && normalized.path !== parent.path && isEqualOrParent(normalized, parent);
    });
    return allowed ? normalized : undefined;
  } catch {
    return undefined;
  }
}

interface ResourceBucket {
  readonly urls: Map<string, string>;
  bytes: number;
}

export class ExtensionResourceUrls extends Disposable {
  private readonly owners = new Map<string, ResourceBucket>();
  private disposed = false;

  constructor(
    private readonly files: () => IFileService,
    private readonly folders: () => readonly string[],
    private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
  ) {
    super();
  }

  async asBrowserUri(key: string, value: string, forWorker: boolean): Promise<string> {
    const owner = this.getExtension(key);
    if (!owner || this.disposed) {
      throw new Error('The extension is no longer registered.');
    }
    const resource = typeof value === 'string' && extensionResourceUri(value, [owner.location, ...this.folders()]);
    if (!resource) {
      throw new Error(`[${owner.id}] The resource must be inside an installed extension folder.`);
    }
    if (!forWorker && /^https?$/i.test(resource.scheme)) {
      return resource.toHttpURL().href;
    }
    const bucket = this.owners.get(key) ?? { urls: new Map<string, string>(), bytes: 0 };
    this.owners.set(key, bucket);
    const cache = (forWorker ? 'script:' : 'file:') + resource.toString();
    const existing = bucket.urls.get(cache);
    if (existing) {
      return existing;
    }
    const { value: bytes } = await this.files().readFile(resource, { limits: { size: maxBlob } });
    if (this.owners.get(key) !== bucket || !this.getExtension(key)) {
      throw new Error(`[${owner.id}] The extension is no longer registered.`);
    }
    const concurrent = bucket.urls.get(cache);
    if (concurrent) {
      return concurrent;
    }
    if (bytes.byteLength > maxBlob || bucket.bytes + bytes.byteLength > maxOwnerBytes) {
      throw new Error(`[${owner.id}] The extension resource limit was exceeded.`);
    }
    const suffix = resource.path.split('.').pop()?.toLowerCase() ?? '';
    const type = forWorker ? 'text/javascript' : (Object.hasOwn(mediaTypes, suffix) ? mediaTypes[suffix] : 'application/octet-stream');
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
    bucket.urls.set(cache, url);
    bucket.bytes += bytes.byteLength;
    return url;
  }

  remove(key: string): void {
    const bucket = this.owners.get(key);
    if (bucket) {
      this.owners.delete(key);
      for (const url of bucket.urls.values()) {
        URL.revokeObjectURL(url);
      }
    }
  }

  override dispose(): void {
    this.disposed = true;
    for (const key of this.owners.keys()) {
      this.remove(key);
    }
    super.dispose();
  }
}
