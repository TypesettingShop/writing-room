import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Schemas } from '../../../../base/common/network.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import {
  ExtensionManagementService, IExtensionManagementService, IExtensionPackageStore, isExtensionPackageLocation,
  isPackageUrl, IWebExtensionsScannerService, localizedDisplayName, normalizeExtensionLocation, normalizePackageUrl,
} from '../../../services/extensionManagement/common/extensionManagementService.js';
import { readPackageIcon } from '../../../services/extensionManagement/browser/extensionPackageStore.js';
import '../../../services/extensionManagement/browser/webExtensionsScannerService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { sessionOnlyNotice, sourceNames } from './extensionInstallConfirmation.js';
import { IExtensionsWorkbenchService } from './extensionsWorkbenchService.js';
import './extensionsViewlet.js';
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
      .then(() => scanner.locked(async (_read, _write, locations) => {
        // Folders named by a record that fails validation stay, and an unreadable list skips the cleanup,
        // so a damaged list never takes an installed package's files with it.
        const recorded = locations();
        if (recorded) {
          await packages.cleanup(recorded);
        } else if (scanner.sessionOnly) {
          console.warn('Skipped the extension package cleanup: the installed extensions list is kept for this session only.');
        } else {
          console.warn('Skipped the extension package cleanup: the installed extensions list cannot be read.');
        }
      }))
      .catch(error => console.warn('Could not clean up extension package folders.', error));
  }
}

registerWorkbenchContribution2('workbench.contrib.extensionPackages', ExtensionPackagesContribution);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function showInstallError(quickInput: IQuickInputService, error: unknown): Promise<void> {
  await quickInput.pick([{ label: 'OK', detail: describeError(error) }], { title: 'Could not install extension' });
}

/** Opens the browser's file chooser for one `.vsix`. It opens only from a user gesture, such as the command. */
function chooseVsixFile(): Promise<File | undefined> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vsix';
    input.hidden = true;
    const done = (file: File | undefined) => {
      input.remove();
      resolve(file);
    };
    let settled = false;
    const finish = (file: File | undefined) => {
      if (!settled) {
        settled = true;
        window.removeEventListener('focus', refocused);
        done(file);
      }
    };
    // A browser without the `cancel` event gives the window focus back when its chooser closes. A chosen
    // file's `change` follows the focus, so wait a moment before taking the focus as a cancellation.
    const refocused = () => setTimeout(() => finish(input.files?.[0]), 1000);
    input.addEventListener('change', () => finish(input.files?.[0]), { once: true });
    input.addEventListener('cancel', () => finish(undefined), { once: true });
    document.body.append(input);
    input.click();
    window.addEventListener('focus', refocused, { once: true });
  });
}

registerAction2(class InstallFromVSIX extends Action2 {
  constructor() {
    super({ id: 'workbench.extensions.action.installVSIX', title: 'Install from VSIX...', f1: true });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService);
    const workbench = accessor.get(IExtensionsWorkbenchService);
    const file = await chooseVsixFile();
    if (!file) {
      return;
    }
    try {
      await workbench.installVsixFile(file);
    } catch (error) {
      await workbench.queuePrompt(() => showInstallError(quickInput, error));
    }
  }
});

registerAction2(class InstallExtensionFromLocation extends Action2 {
  constructor() {
    super({ id: 'workbench.extensions.action.installExtensionFromLocation', title: 'Install Extension from Location...', f1: true });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService);
    const management = accessor.get(IExtensionManagementService);
    const workbench = accessor.get(IExtensionsWorkbenchService);
    const notifications = accessor.get(INotificationService);
    const location = await workbench.queuePrompt(() => quickInput.input({
      title: 'Install Extension from Location',
      placeHolder: 'Extension directory URL or .vsix URL',
      validateInput: value => {
        try {
          if (isPackageUrl(value)) {
            normalizePackageUrl(value);
          } else {
            normalizeExtensionLocation(value);
          }
          return undefined;
        } catch (error) {
          return describeError(error);
        }
      },
    }));
    if (location === undefined) {
      return;
    }
    try {
      if (isPackageUrl(location)) {
        const abort = new AbortController();
        const progress = notifications.notify({
          severity: Severity.Info, message: 'Downloading VSIX…', progress: { infinite: true },
          actions: [{ label: 'Cancel', run: () => abort.abort() }],
        });
        const dismissed = progress.onDidClose(() => abort.abort());
        if (progress.closed) {
          abort.abort();
        }
        try {
          await management.installFromPackageUrl(location, async confirmation => {
            progress.updateMessage('Waiting to confirm VSIX installation…');
            const accepted = await workbench.confirmInstall(confirmation, abort.signal);
            dismissed.dispose();
            progress.close();
            return accepted;
          }, { signal: abort.signal });
        } catch (error) {
          if (!abort.signal.aborted) {
            throw error;
          }
        } finally {
          dismissed.dispose();
          progress.close();
        }
        return;
      }
      await management.installFromLocation(location, async ({ manifest, location, nls }, { persistent }) => {
        const origin = new URL(location).origin;
        const name = localizedDisplayName(manifest, nls);
        const selected = await workbench.queuePrompt(() => quickInput.pick([
          { id: 'cancel', label: 'Cancel' },
          {
            id: 'install',
            label: 'Install',
            description: `${name} · ${manifest.publisher} · ${manifest.version}`,
            detail: [origin, ...persistent ? [] : [sessionOnlyNotice], 'Extension code can make requests as this page’s origin.'].join(' · '),
          },
        ], { title: 'Install extension from ' + origin }));
        return selected?.id === 'install';
      });
    } catch (error) {
      await workbench.queuePrompt(() => showInstallError(quickInput, error));
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
    const workbench = accessor.get(IExtensionsWorkbenchService);
    const records = new Map(accessor.get(IWebExtensionsScannerService).scanUserExtensions().map(record => [record.identifier, record]));
    const entries = management.installed.map(({ identifier, manifest, location, nls }) => {
      const record = records.get(identifier.value);
      const source = record ? sourceNames[record.source] : isExtensionPackageLocation(location) ? 'package' : 'folder URL';
      return {
        id: identifier.value, label: localizedDisplayName(manifest, nls),
        description: `${identifier.value} · ${manifest.version} · ${source}`,
        detail: isExtensionPackageLocation(location) ? 'Stored in this browser' : new URL(location).origin,
      };
    });
    if (!entries.length) {
      await workbench.queuePrompt(() => quickInput.pick([{ label: 'OK' }], { title: 'No installed extensions' }));
      return;
    }
    const selection = await workbench.queuePrompt(() => quickInput.pick(entries, { title: 'Uninstall Extension' }));
    if (selection) {
      try {
        await management.uninstall(selection.id);
      } catch (error) {
        await workbench.queuePrompt(() => quickInput.pick([{ label: 'OK', detail: describeError(error) }], { title: 'Could not uninstall extension' }));
      }
    }
  }
});
