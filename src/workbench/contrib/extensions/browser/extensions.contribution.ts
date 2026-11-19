import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Schemas } from '../../../../base/common/network.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import {
  ExtensionManagementService, IExtensionManagementService, IExtensionPackageStore, IWebExtensionsScannerService,
  normalizeExtensionLocation,
} from '../../../services/extensionManagement/common/extensionManagementService.js';
import { readPackageIcon } from '../../../services/extensionManagement/browser/extensionPackageStore.js';
import '../../../services/extensionManagement/browser/webExtensionsScannerService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { registerExtensionIconReader } from '../../../services/extensions/browser/remoteExtensionIcons.js';

registerSingleton(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService, [
  (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
]));

/** Serves package icons to the workbench and clears what interrupted installs left behind. */
class ExtensionPackagesContribution extends Disposable {
  constructor(
    @IFileService files: IFileService,
    @IExtensionService extensions: IExtensionService,
    @IWebExtensionsScannerService scanner: IWebExtensionsScannerService,
    @IExtensionPackageStore packages: IExtensionPackageStore,
  ) {
    super();
    this._register(toDisposable(registerExtensionIconReader(Schemas.vscodeUserData,
      (url, limit, signal) => readPackageIcon(files, url, limit, signal)).dispose));
    void extensions.whenInstalledExtensionsRegistered()
      .then(() => scanner.locked(async read => packages.cleanup(new Set(read().map(extension => extension.location)))))
      .catch(error => console.warn('Could not clean up extension package folders.', error));
  }
}

registerWorkbenchContribution2('workbench.contrib.extensionPackages', ExtensionPackagesContribution);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerAction2(class InstallExtensionFromLocation extends Action2 {
  constructor() {
    super({ id: 'workbench.extensions.action.installExtensionFromLocation', title: 'Install Extension from Location...', f1: true });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService);
    const management = accessor.get(IExtensionManagementService);
    const location = await quickInput.input({
      title: 'Install Extension from Location',
      placeHolder: 'Extension directory URL',
      validateInput: value => {
        try {
          normalizeExtensionLocation(value);
          return undefined;
        } catch (error) {
          return describeError(error);
        }
      },
    });
    if (location === undefined) {
      return;
    }
    try {
      await management.installFromLocation(location, async ({ manifest, location }) => {
        const origin = new URL(location).origin;
        const name = manifest.displayName ?? manifest.name;
        const selected = await quickInput.pick([
          { id: 'cancel', label: 'Cancel' },
          {
            id: 'install',
            label: 'Install',
            description: `${name} · ${manifest.publisher} · ${manifest.version}`,
            detail: `${origin} · Extension code can make requests as this page’s origin.`,
          },
        ], { title: 'Install extension from ' + origin });
        return selected?.id === 'install';
      });
    } catch (error) {
      await quickInput.pick([{ label: 'OK', detail: describeError(error) }], { title: 'Could not install extension' });
    }
  }
});

registerAction2(class UninstallExtension extends Action2 {
  constructor() {
    super({ id: 'workbench.extensions.uninstallExtension', title: 'Uninstall Extension...', f1: true });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService);
    const management = accessor.get(IExtensionManagementService);
    const entries = management.installed.map(({ identifier, manifest, location }) => ({
      id: identifier.value, label: manifest.displayName ?? manifest.name,
      description: `${identifier.value} · ${manifest.version}`, detail: new URL(location).origin,
    }));
    if (!entries.length) {
      await quickInput.pick([{ label: 'OK' }], { title: 'No installed extensions' });
      return;
    }
    const selection = await quickInput.pick(entries, { title: 'Uninstall Extension' });
    if (selection) {
      try {
        await management.uninstall(selection.id);
      } catch (error) {
        await quickInput.pick([{ label: 'OK', detail: describeError(error) }], { title: 'Could not uninstall extension' });
      }
    }
  }
});
