import { ThemeIcon } from '../../../../base/common/themables.js';
import { fetchBoundedResource, ResourceRequestError } from '../../../../base/parts/request/common/boundedFetch.js';
import { isRecord, validateExtensionManifest } from '../../../../platform/extensions/common/extensionValidator.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription, IExtensionManifest } from '../../../../platform/extensions/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { extensionResourceLimits, resolveExtensionPath } from '../../extensions/common/extensionResources.js';
import { IExtensionService } from '../../extensions/common/extensions.js';

export interface StoredWebExtension {
  readonly identifier: string;
  readonly location: string;
  readonly manifest: IExtensionManifest;
  readonly installedAt: number;
}

export const IWebExtensionsScannerService = createDecorator<IWebExtensionsScannerService>('webExtensionsScannerService');

export interface IWebExtensionsScannerService extends BrandedService {
  scanUserExtensions(): readonly StoredWebExtension[];
  write(extensions: readonly StoredWebExtension[]): Promise<() => Promise<void>>;
}

export const IExtensionManagementService = createDecorator<ExtensionManagementService>('extensionManagementService');

export function normalizeExtensionLocation(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter an absolute URL for the extension directory.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS or HTTP on localhost or 127.0.0.1.');
  }
  if (url.username || url.password) {
    throw new Error('The extension URL must not contain credentials.');
  }
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url;
}

export function validateInstalledManifest(input: unknown, location: string): IExtensionManifest {
  const resolve = (path: string) => resolveExtensionPath(location, path);
  const { manifest, messages } = validateExtensionManifest(input, resolve);
  if (!manifest) {
    throw new Error(messages.map(({ path, message }) => path + ': ' + message).join(' '));
  }
  const validateIcon = (entry: unknown, path: string) => {
    if (isRecord(entry) && entry.icon !== undefined) {
      if (typeof entry.icon !== 'string' || (!ThemeIcon.fromString(entry.icon) && !resolve(entry.icon))) {
        throw new Error(path + '.icon: Expected a codicon or a path inside the extension directory.');
      }
    }
  };
  const containers = manifest.contributes?.viewsContainers;
  if (isRecord(containers)) {
    for (const [key, entries] of Object.entries(containers)) {
      if (Array.isArray(entries)) {
        entries.forEach((entry, index) => validateIcon(entry, 'contributes.viewsContainers.' + key + '.' + index));
      }
    }
  }
  return manifest;
}

export function toExtensionDescription(extension: Pick<StoredWebExtension, 'identifier' | 'location' | 'manifest'>): IExtensionDescription {
  const { identifier, location, manifest } = extension;
  return { identifier: new ExtensionIdentifier(identifier), location, manifest, isBuiltin: false };
}

export class ExtensionManagementService {
  declare readonly _serviceBrand: undefined;
  private readonly pendingLocations = new Map<string, Promise<IExtensionDescription | undefined>>();
  private writes = Promise.resolve();

  constructor(
    private readonly fetchManifest: typeof fetch,
    @IWebExtensionsScannerService private readonly scanner: IWebExtensionsScannerService,
    @IExtensionService private readonly active: IExtensionService,
  ) {}

  get installed(): readonly IExtensionDescription[] {
    return this.active.extensions?.filter(extension => !extension.isBuiltin) ?? [];
  }

  async installFromLocation(
    value: string,
    confirm: (extension: IExtensionDescription) => Promise<boolean>,
  ): Promise<IExtensionDescription | undefined> {
    await this.active.whenInstalledExtensionsRegistered();
    const location = normalizeExtensionLocation(value);
    const existing = this.pendingLocations.get(location.href);
    if (existing) {
      return existing;
    }
    const request = this.install(location, confirm).finally(() => this.pendingLocations.delete(location.href));
    this.pendingLocations.set(location.href, request);
    return request;
  }

  private async install(
    location: URL,
    confirm: (extension: IExtensionDescription) => Promise<boolean>,
  ): Promise<IExtensionDescription | undefined> {
    const manifest = validateInstalledManifest(await this.loadManifest(location), location.href);
    const identifier = ExtensionIdentifier.fromManifest(manifest).value;
    this.ensureAvailable(identifier, this.scanner.scanUserExtensions());
    const stored = { identifier, location: location.href, manifest };
    const description = toExtensionDescription(stored);
    if (!await confirm(description)) {
      return undefined;
    }
    return this.write(async () => {
      const installed = this.scanner.scanUserExtensions();
      this.ensureAvailable(identifier, installed);
      const rollback = await this.scanner.write([...installed, { ...stored, installedAt: Date.now() }]);
      try {
        if (!this.active.addExtension?.(description)) {
          throw new Error(`Could not register extension '${identifier}'.`);
        }
      } catch (error) {
        await rollback();
        throw error;
      }
      return description;
    });
  }

  private ensureAvailable(identifier: string, installed: readonly StoredWebExtension[]): void {
    const extension = this.active.extensions?.find(entry => entry.identifier.value === identifier);
    if (extension?.isBuiltin) {
      throw new Error(`'${identifier}' is a built-in extension.`);
    }
    if (extension || installed.some(entry => entry.identifier === identifier)) {
      throw new Error(`'${identifier}' is already installed. Uninstall it before replacing it.`);
    }
  }

  private async loadManifest(location: URL): Promise<unknown> {
    const manifestUrl = new URL('package.json', location);
    let text: string;
    try {
      const { bytes } = await fetchBoundedResource(manifestUrl, {
        limit: extensionResourceLimits.manifest, request: this.fetchManifest,
      });
      text = new TextDecoder().decode(bytes);
    } catch (error) {
      if (error instanceof ResourceRequestError) {
        throw new Error(`Cannot fetch the manifest from ${location.origin}. The server may be unavailable, may require a redirect, or may not allow cross-origin requests (CORS).`);
      }
      throw new Error(`Could not read package.json from ${location.origin}: ${error instanceof Error ? error.message : error}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('The extension package.json must contain valid JSON.');
    }
  }

  async uninstall(identifier: string): Promise<boolean> {
    return this.write(async () => {
      const id = identifier.toLowerCase();
      if (!this.installed.some(extension => extension.identifier.value === id)) {
        return false;
      }
      const remaining = this.scanner.scanUserExtensions().filter(extension => extension.identifier !== id);
      const rollback = await this.scanner.write(remaining);
      try {
        if (this.active.removeExtension?.(id)) {
          return true;
        }
      } catch (error) {
        await rollback();
        throw error;
      }
      await rollback();
      return false;
    });
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.then(() => {}, () => {});
    return result;
  }
}
