import type { Page } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';

export function extensionFixtureLocation(name: string): string {
  const port = process.env.E2E_EXTENSIONS_PORT;
  if (!port || !/^[a-z\d-]+$/i.test(name)) {
    throw new Error('An extension fixture needs a server port and a fixture directory name.');
  }
  return 'http://127.0.0.1:' + port + '/' + name + '/';
}

export interface InstalledExtensionFixture {
  readonly manifest: IExtensionManifest;
  readonly location: string;
}

function makeStorageSeed(extensions: readonly InstalledExtensionFixture[]) {
  // PKG can update the storage schema and record shape at this single boundary.
  const installed = extensions.map(({ location, manifest }) => {
    const base = new URL(location);
    base.hash = '';
    base.search = '';
    if (!base.pathname.endsWith('/')) {
      base.pathname += '/';
    }
    return {
      identifier: (manifest.publisher + '.' + manifest.name).toLowerCase(),
      location: base.href,
      manifest,
      installedAt: 1,
    };
  });
  return {
    schemaKey: 'writing-room:storage:version',
    schemaVersion: '1',
    installedKey: 'writing-room:storage:0:extensions.user',
    installed: JSON.stringify(installed),
  };
}

/** Seed installed extensions once for this tab before its workbench initializes. */
export async function seedInstalledExtensions(page: Page, extensions: readonly InstalledExtensionFixture[]): Promise<void> {
  await page.addInitScript(({ schemaKey, schemaVersion, installedKey, installed }) => {
    const seededKey = 'writing-room:test:installed-extensions-seeded';
    if (window.top !== window || !/^https?:$/.test(location.protocol) || sessionStorage.getItem(seededKey)) {
      return;
    }
    const currentSchema = localStorage.getItem(schemaKey);
    if (currentSchema !== null && currentSchema !== schemaVersion) {
      throw new Error('The extension fixture storage schema does not match the workbench.');
    }
    localStorage.setItem(schemaKey, schemaVersion);
    localStorage.setItem(installedKey, installed);
    sessionStorage.setItem(seededKey, 'true');
  }, makeStorageSeed(extensions));
}
