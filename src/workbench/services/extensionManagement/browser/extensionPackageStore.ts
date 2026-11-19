import { Schemas } from '../../../../base/common/network.js';
import { extname } from '../../../../base/common/path.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { VsixFile, VsixPackage } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import { normalizeFileResource } from '../../../../platform/files/common/fileResource.js';
import { FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import type { IFileStat } from '../../../../platform/files/common/files.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { extensionPackageLocation, extensionPackageRoot, IExtensionPackageStore, isExtensionPackageLocation } from '../common/extensionManagementService.js';
import type { StagedExtensionPackage } from '../common/extensionManagementService.js';

export const extensionPackagesRoot = URI.from({ scheme: Schemas.vscodeUserData, path: '/extensions' });
const temporaryPrefix = '.tmp-';
/** Leftovers younger than this may belong to an install still running in another tab. */
export const extensionPackageCleanupAge = 60 * 60 * 1000;

interface StagedFolder extends StagedExtensionPackage {
  readonly folder: URI;
}

function packageFolder(location: string): URI {
  const name = isExtensionPackageLocation(location) && location.endsWith('/')
    ? location.slice(extensionPackageRoot.length, -1) : '';
  if (!/^[\da-z][\da-z.+-]*$/i.test(name)) {
    throw new Error(`'${location}' is not an extension package folder.`);
  }
  return joinPath(extensionPackagesRoot, name);
}

function isNotFound(error: unknown): boolean {
  return toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound;
}

const iconTypes = new Map([
  ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);

/** Reads an icon of an installed package for the workbench, which cannot load `vscode-userdata` URLs itself. */
export async function readPackageIcon(
  files: IFileService, url: URL, limit: number, signal: AbortSignal,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
  const resource = normalizeFileResource(URI.parse(url.href));
  const [, root, folder] = resource.path.split('/', 3);
  const contentType = iconTypes.get(extname(resource.path).toLowerCase());
  if (resource.scheme !== Schemas.vscodeUserData || root !== 'extensions' || !folder || folder.startsWith('.')
    || resource.path.split('/').length < 4) {
    throw new Error(`'${url.href}' is not inside an extension package folder.`);
  }
  if (!contentType) {
    throw new Error(`'${url.href}' is not a supported icon image.`);
  }
  const { value } = await files.readFile(resource, { limits: { size: limit }, signal });
  return { bytes: new Uint8Array(value), contentType };
}

/** Package folders in user data: `vscode-userdata:/extensions/<publisher>.<name>-<version>/`. */
export class ExtensionPackageStore implements IExtensionPackageStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly now: () => number = Date.now,
    @IFileService private readonly files: IFileService,
  ) {}

  async isPersistent(): Promise<boolean> {
    // The user data provider opens its database on first use and says whether it fell back to memory.
    await this.files.exists(extensionPackagesRoot);
    const provider = this.files.getProvider(Schemas.vscodeUserData) as { database?: { usesMemory?: unknown } } | undefined;
    return provider?.database?.usesMemory !== true;
  }

  /** Writes the package's files under a new temporary folder and checks that they all arrived. */
  async stage(
    pkg: VsixPackage, signal?: AbortSignal, preloaded?: ReadonlyMap<VsixFile, Uint8Array<ArrayBuffer>>,
  ): Promise<StagedExtensionPackage> {
    const folder = joinPath(extensionPackagesRoot, temporaryPrefix + crypto.randomUUID());
    const staged: StagedFolder = { identifier: pkg.identifier, version: pkg.manifest.version, folder };
    try {
      await this.files.createFolder(folder);
      for (const file of pkg.files) {
        signal?.throwIfAborted();
        const bytes = preloaded?.get(file) ?? await pkg.read(file, signal);
        await this.files.writeFile(joinPath(folder, ...file.path.split('/')), bytes);
      }
      await this.verify(folder, pkg);
    } catch (error) {
      await this.files.del(folder, { recursive: true }).catch(cleanup => {
        if (!isNotFound(cleanup)) {
          console.warn(`Could not remove the temporary extension folder '${folder.path}'.`, cleanup);
        }
      });
      if (toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileExceedsStorageQuota) {
        throw new Error(`Not enough browser storage for '${pkg.identifier}': its files need ${pkg.size} bytes.`, { cause: error });
      }
      throw error;
    }
    return staged;
  }

  /** Moves the staged files to the package folder in one storage transaction. */
  async commit(staged: StagedExtensionPackage, overwrite: boolean): Promise<string> {
    const location = extensionPackageLocation(staged.identifier, staged.version);
    await this.files.move((staged as StagedFolder).folder, packageFolder(location), overwrite);
    return location;
  }

  async discard(staged: StagedExtensionPackage): Promise<void> {
    try {
      await this.files.del((staged as StagedFolder).folder, { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  async remove(location: string): Promise<void> {
    try {
      await this.files.del(packageFolder(location), { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  async cleanup(recorded: ReadonlySet<string>): Promise<void> {
    let root: IFileStat;
    try {
      root = await this.files.resolve(extensionPackagesRoot);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    const now = this.now();
    for (const child of root.children ?? []) {
      const age = now - Math.max(child.ctime, child.mtime);
      const location = extensionPackageRoot + child.name + '/';
      const leftover = child.name.startsWith(temporaryPrefix) || !child.isDirectory || !recorded.has(location);
      if (leftover && age > extensionPackageCleanupAge) {
        try {
          await this.files.del(child.resource, { recursive: true });
        } catch (error) {
          if (!isNotFound(error)) {
            console.warn(`Could not remove the leftover extension folder '${child.resource.path}'.`, error);
          }
        }
      }
    }
  }

  private async verify(folder: URI, pkg: VsixPackage): Promise<void> {
    const written = new Map<string, number>();
    const walk = async (resource: URI, prefix: string) => {
      for (const child of (await this.files.resolve(resource)).children ?? []) {
        if (child.isDirectory) {
          await walk(child.resource, prefix + child.name + '/');
        } else {
          written.set(prefix + child.name, child.size);
        }
      }
    };
    await walk(folder, '');
    const missing = pkg.files.find(file => written.get(file.path) !== file.size);
    if (missing || written.size !== pkg.files.length) {
      throw new Error(`The package of '${pkg.identifier}' was not stored completely`
        + (missing ? `: '${missing.path}' is missing or has the wrong size.` : '.'));
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(new TextDecoder().decode((await this.files.readFile(joinPath(folder, 'package.json'))).value));
    } catch (error) {
      throw new Error(`The stored package.json of '${pkg.identifier}' cannot be read.`, { cause: error });
    }
    if (!isRecord(manifest) || typeof manifest.publisher !== 'string' || typeof manifest.name !== 'string'
      || ExtensionIdentifier.fromManifest({ publisher: manifest.publisher, name: manifest.name }).value !== pkg.identifier
      || manifest.version !== pkg.manifest.version) {
      throw new Error(`The stored package.json of '${pkg.identifier}' does not match the package being installed.`);
    }
  }
}

registerSingleton(IExtensionPackageStore, ExtensionPackageStore);
