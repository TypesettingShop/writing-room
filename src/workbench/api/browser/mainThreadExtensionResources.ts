import { TransferableBuffer } from '../../../base/common/marshalling.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { normalizeFileResource } from '../../../platform/files/common/fileResource.js';
import { IFileService } from '../../../platform/files/common/files.js';
import type { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { isExtensionPackageLocation } from '../../services/extensionManagement/common/extensionManagementService.js';
import { extensionResourceLimits, resolveExtensionEntry } from '../../services/extensions/common/extensionResources.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { MainThreadExtensionResourcesProxy } from '../common/extHost.protocol.packages.js';
import type { MainThreadExtensionResourcesShape } from '../common/extHost.protocol.packages.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';

/** The normalized `vscode-userdata` path of a registered package extension's entry, if `entry` names one. */
export function findPackageEntry(extensions: readonly IExtensionDescription[], entry: string): string | undefined {
  let requested: URI;
  try {
    requested = normalizeFileResource(URI.parse(entry));
  } catch {
    return undefined;
  }
  if (requested.scheme !== Schemas.vscodeUserData) {
    return undefined;
  }
  for (const { isBuiltin, location, manifest } of extensions) {
    const expected = !isBuiltin && isExtensionPackageLocation(location) && manifest.browser
      ? resolveExtensionEntry(location, manifest.browser) : undefined;
    // Only the exact entry of an installed package is readable, never another file of user data.
    if (expected && URI.parse(expected.href).path === requested.path) {
      return requested.path;
    }
  }
  return undefined;
}

export class MainThreadExtensionResources implements MainThreadExtensionResourcesShape {
  constructor(
    private readonly extensions: () => readonly IExtensionDescription[],
    private readonly files: IFileService,
  ) {}

  async $readPackageEntry(entry: unknown): Promise<Uint8Array> {
    const path = typeof entry === 'string' ? findPackageEntry(this.extensions(), entry) : undefined;
    if (!path) {
      throw new Error(`'${String(entry)}' is not the entry of an installed extension package.`);
    }
    const { value } = await this.files.readFile(URI.from({ scheme: Schemas.vscodeUserData, path }), {
      limits: { size: extensionResourceLimits.packageEntry },
    });
    return new TransferableBuffer(value) as unknown as Uint8Array;
  }
}

mainThreadCustomers.register('packages', ({ rpc, instantiation }) => {
  const [extensions, files] = instantiation.invokeFunction(accessor =>
    [accessor.get(IExtensionService), accessor.get(IFileService)] as const);
  rpc.set(MainThreadExtensionResourcesProxy, new MainThreadExtensionResources(() => extensions.extensions ?? [], files));
  return {};
});
