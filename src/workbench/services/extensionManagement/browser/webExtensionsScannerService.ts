import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWebExtensionsScannerService, normalizeExtensionLocation, validateInstalledManifest } from '../common/extensionManagementService.js';
import type { StoredWebExtension } from '../common/extensionManagementService.js';

export const userExtensionsKey = 'extensions.user';
const scope = StorageScope.PROFILE;

export class WebExtensionsScannerService implements IWebExtensionsScannerService {
  declare readonly _serviceBrand: undefined;

  constructor(@IStorageService private readonly storage: IStorageService) {}

  scanUserExtensions(): readonly StoredWebExtension[] {
    const raw = this.storage.get(userExtensionsKey, scope);
    if (!raw) {
      return [];
    }
    let entries: unknown;
    try {
      entries = JSON.parse(raw);
      if (!Array.isArray(entries)) {
        throw new Error('Expected an array.');
      }
    } catch (error) {
      console.warn('Could not read the installed extensions list.', error);
      return [];
    }
    const installed = new Map<string, StoredWebExtension>();
    for (const entry of entries) {
      try {
        if (!isRecord(entry) || typeof entry.identifier !== 'string' || typeof entry.location !== 'string'
          || typeof entry.installedAt !== 'number' || !Number.isFinite(entry.installedAt) || entry.installedAt < 0) {
          throw new Error('Invalid installed extension record.');
        }
        const location = normalizeExtensionLocation(entry.location).href;
        const manifest = validateInstalledManifest(entry.manifest, location);
        const identifier = ExtensionIdentifier.fromManifest(manifest).value;
        if (entry.identifier.toLowerCase() !== identifier || installed.has(identifier)) {
          throw new Error(`Invalid or duplicate identifier '${entry.identifier}'.`);
        }
        installed.set(identifier, { identifier, location, manifest, installedAt: entry.installedAt });
      } catch (error) {
        console.warn('Skipping an invalid installed extension.', error);
      }
    }
    return [...installed.values()];
  }

  async write(extensions: readonly StoredWebExtension[]): Promise<() => Promise<void>> {
    const before = this.storage.get(userExtensionsKey, scope);
    const restore = () => this.save(before);
    try {
      await this.save(extensions.length ? JSON.stringify(extensions) : undefined);
    } catch (error) {
      try {
        await restore();
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Could not save or restore the installed extensions list.');
      }
      throw error;
    }
    return restore;
  }

  private async save(value: string | undefined): Promise<void> {
    if (value === undefined) {
      this.storage.remove(userExtensionsKey, scope);
    } else {
      this.storage.store(userExtensionsKey, value, scope, StorageTarget.USER);
    }
    await this.storage.flush();
  }
}

registerSingleton(IWebExtensionsScannerService, WebExtensionsScannerService);
