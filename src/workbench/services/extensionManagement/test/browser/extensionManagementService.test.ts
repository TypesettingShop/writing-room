import { expect, test, vi } from 'vitest';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import { InMemoryStorageDatabase } from '../../../../../base/parts/storage/common/storage.js';
import { InMemoryStorageService, storageKey, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { NullExtensionService } from '../../../extensions/common/extensions.js';
import { ExtensionPackageStore } from '../../browser/extensionPackageStore.js';
import { userExtensionsKey, WebExtensionsScannerService } from '../../browser/webExtensionsScannerService.js';
import { ExtensionManagementService, installLifetimeChangedError, normalizeExtensionLocation } from '../../common/extensionManagementService.js';

const location = 'http://127.0.0.1:5000/ext/';
const manifest = { name: 'fixture', publisher: 'Example', version: '1.0.0', browser: 'entry.js' };

function setup(load: typeof fetch = async () => Response.json(manifest), storage = new InMemoryStorageService()) {
  const scanner = new WebExtensionsScannerService(null, storage);
  const packages = new ExtensionPackageStore(Date.now, new FileService());
  const extensions: IExtensionDescription[] = [];
  const active = Object.assign(new NullExtensionService(), {
    extensions,
    addExtension: vi.fn((extension: IExtensionDescription) => {
      extensions.push(extension);
      return true;
    }),
    removeExtension: vi.fn((id: string) => {
      const index = extensions.findIndex(extension => extension.identifier.value === id);
      extensions.splice(index, 1);
      return true;
    }),
  });
  const fetch = vi.fn(load);
  const service = new ExtensionManagementService(fetch, scanner, active, packages);
  return { storage, scanner, fetch, active, service };
}

test.each([
  'http://example.com/ext/', 'file:///tmp/ext/', 'data:text/plain,hi', 'javascript:void(0)',
  'https://user:password@example.com/ext/', '/relative',
])('rejects %s before fetching', async value => {
  const { service, fetch } = setup();
  await expect(service.installFromLocation(value, async () => true)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

test('normalizes directory locations and removes search and fragment', () => {
  expect(normalizeExtensionLocation('http://localhost:5000/ext?ignored=yes#fragment').href).toBe('http://localhost:5000/ext/');
  expect(normalizeExtensionLocation('https://EXAMPLE.com/ext').href).toBe('https://example.com/ext/');
});

test('fetches only the manifest before origin confirmation and leaves cancellation unwritten', async () => {
  const { storage, fetch, active, service } = setup();
  await expect(service.installFromLocation(location, async extension => {
    expect(extension.location).toBe(location);
    expect(extension.manifest).toEqual(manifest);
    expect(extension.isBuiltin).toBe(false);
    expect(storage.get(userExtensionsKey, StorageScope.PROFILE)).toBeUndefined();
    expect(active.addExtension).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL('package.json', location), expect.objectContaining({
      credentials: 'omit', redirect: 'error', mode: 'cors',
    }));
    return false;
  })).resolves.toBeUndefined();
  expect(storage.get(userExtensionsKey, StorageScope.PROFILE)).toBeUndefined();
  expect(active.extensions).toEqual([]);
});

test('serializes concurrent installs and removes both catalog and active registration', async () => {
  const { storage, scanner, fetch, active, service } = setup();
  const confirm = vi.fn(async () => true);
  const [one, two] = await Promise.all([
    service.installFromLocation(location, confirm), service.installFromLocation(location + '?same', confirm),
  ]);
  expect(one).toBe(two);
  expect(confirm).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
  expect(active.addExtension).toHaveBeenCalledOnce();
  expect(scanner.scanUserExtensions()).toEqual([expect.objectContaining({
    identifier: 'example.fixture', location, installedAt: expect.any(Number), manifest, source: 'location', version: '1.0.0',
  })]);
  await expect(service.installFromLocation(location, confirm)).rejects.toThrow('already installed');
  await expect(service.uninstall('EXAMPLE.FIXTURE')).resolves.toBe(true);
  expect(active.removeExtension).toHaveBeenCalledExactlyOnceWith('example.fixture');
  expect(storage.get(userExtensionsKey, StorageScope.PROFILE)).toBeUndefined();
});

test('leaves no contribution when writing fails and writes no list when registration fails', async () => {
  const { storage, scanner, active, service } = setup();
  const write = vi.spyOn(storage, 'storeImmediately').mockImplementationOnce(() => { throw new Error('write failed'); });
  await expect(service.installFromLocation(location, async () => true)).rejects.toThrow('write failed');
  // A folder install registers before the cross-tab write and unregisters when that write fails.
  expect(active.extensions).toEqual([]);
  expect(active.removeExtension).toHaveBeenCalledExactlyOnceWith('example.fixture');
  write.mockRestore();
  active.addExtension.mockReturnValueOnce(false);
  await expect(service.installFromLocation(location, async () => true)).rejects.toThrow('Could not register');
  expect(storage.get(userExtensionsKey, StorageScope.PROFILE)).toBeUndefined();
});

test('rejects duplicate built-ins and manifests with invalid fields or paths before confirmation', async () => {
  const valid = setup();
  valid.active.extensions.push({
    isBuiltin: true, identifier: ExtensionIdentifier.fromManifest(manifest), manifest, location,
  });
  const confirm = vi.fn(async () => true);
  await expect(valid.service.installFromLocation(location, confirm)).rejects.toThrow('built-in extension');
  for (const input of [
    { ...manifest, version: undefined },
    { ...manifest, browser: '../entry.js' },
    { ...manifest, icon: 'https://other-origin.test/icon.png' },
    { ...manifest, contributes: { viewsContainers: {
      activitybar: [{ id: 'test', title: 'Test', icon: '%2E%2e/icon.png' }],
    } } },
  ]) {
    const { storage, service } = setup(async () => Response.json(input));
    await expect(service.installFromLocation(location, confirm)).rejects.toThrow();
    expect(storage.get(userExtensionsKey, StorageScope.PROFILE)).toBeUndefined();
  }
  expect(confirm).not.toHaveBeenCalled();
});

test('preserves command icon metadata through installation and a saved manifest rescan', async () => {
  const commands = [
    { command: 'test.valid', title: 'Valid icon', icon: { light: 'light.svg', dark: 'dark.svg' } },
    { command: 'test.invalid', title: 'Invalid icon', icon: '%2E%2e/icon.png' },
  ];
  const input = { ...manifest, contributes: { commands } };
  const { active, scanner, fetch, service } = setup(async () => Response.json(input));
  await service.installFromLocation(location, async () => true);
  expect(active.extensions[0].manifest.contributes?.commands).toEqual(commands);
  expect(scanner.scanUserExtensions()[0].manifest.contributes?.commands).toEqual(commands);
  expect(fetch).toHaveBeenCalledOnce();
});

test('cancels a streamed manifest at the limit and reports invalid JSON', async () => {
  const cancel = vi.fn();
  let chunks = 0;
  const { service } = setup(async () => new Response(new ReadableStream({
    pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel,
  })));
  await expect(service.installFromLocation(location, async () => true)).rejects.toThrow('exceeds 262144 bytes');
  expect(cancel).toHaveBeenCalledOnce();
  expect(chunks).toBeLessThan(7);
  const invalid = setup(async () => new Response('not json'));
  await expect(invalid.service.installFromLocation(location, async () => true)).rejects.toThrow('valid JSON');
});

test('restores good saved records around invalid or corrupt data', () => {
  const { storage, scanner } = setup();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const record = { identifier: 'example.fixture', location, manifest, installedAt: 1, source: 'location', version: '1.0.0' };
    storage.store(userExtensionsKey, [null, { ...record, identifier: 'wrong.id' }, record], StorageScope.PROFILE, StorageTarget.USER);
    expect(scanner.scanUserExtensions()).toEqual([record]);
    expect(warn).toHaveBeenCalledTimes(2);
    storage.store(userExtensionsKey, 'corrupt', StorageScope.PROFILE, StorageTarget.USER);
    expect(scanner.scanUserExtensions()).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});


test('a folder reinstall can start while the previous registration is awaiting deactivation', async () => {
  const fetched = new DeferredPromise<void>();
  const { active, service, scanner, fetch } = setup();
  await service.installFromLocation(location, async () => true);
  fetch.mockImplementationOnce(async () => {
    await fetched.complete();
    return Response.json(manifest);
  });
  const removing = new DeferredPromise<void>();
  const deactivated = new DeferredPromise<void>();
  Object.assign(active, { whenExtensionRemoved: async () => {
    await removing.complete();
    await deactivated.p;
  } });
  const removal = service.uninstall('example.fixture');
  await removing.p;
  const confirm = vi.fn(async () => true);
  const reinstall = service.installFromLocation(location, confirm);
  // Observe any premature rejection while the old record still belongs to the pending removal.
  const premature = vi.fn();
  void reinstall.catch(premature);
  try {
    await fetched.p;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(premature).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  } finally {
    await deactivated.complete();
    await Promise.allSettled([removal, reinstall]);
  }
  await expect(reinstall).resolves.toMatchObject({ location });
  expect(confirm).toHaveBeenCalledOnce();
  expect(scanner.scanUserExtensions()).toEqual([expect.objectContaining({ identifier: 'example.fixture' })]);
});

/** A storage backend that cannot be opened, so the storage starts in memory mode. */
class BlockedDatabase extends InMemoryStorageDatabase {
  override getItems(): Map<string, string> {
    throw new DOMException('Access is denied for this document.', 'SecurityError');
  }
}

test('tells the folder URL confirmation that a session-only list keeps the install for this session', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = new InMemoryStorageService(new BlockedDatabase());
  const { scanner, active, service } = setup(undefined, storage);
  const immediate = vi.spyOn(storage, 'storeImmediately');
  const confirm = vi.fn(async () => true);
  await expect(service.installFromLocation(location, confirm)).resolves.toMatchObject({ location });
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.anything(), { persistent: false });
  expect(active.extensions.map(extension => extension.location)).toEqual([location]);
  expect(scanner.scanUserExtensions()).toEqual([expect.objectContaining({ identifier: 'example.fixture', location })]);

  await expect(service.uninstall('example.fixture')).resolves.toBe(true);
  expect(scanner.scanUserExtensions()).toEqual([]);
  await expect(service.installFromLocation(location, confirm)).resolves.toMatchObject({ location });
  expect(immediate).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

test('tells the folder URL confirmation that a persistent list keeps the install', async () => {
  const { service } = setup();
  const confirm = vi.fn(async () => false);
  await service.installFromLocation(location, confirm);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.anything(), { persistent: true });
});

test.each(['at confirmation', 'inside the list lock'])(
  'rejects a persistent folder URL install when the list falls back %s and allows a session-only retry',
  async timing => {
    const database = new InMemoryStorageDatabase();
    const storage = new InMemoryStorageService(database);
    const { scanner, active, service } = setup(undefined, storage);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallBack = () => {
      vi.spyOn(database, 'updateItems').mockImplementationOnce(() => { throw new Error('quota exceeded'); });
      storage.store('unrelated', 'value', StorageScope.PROFILE, StorageTarget.USER);
      void storage.flush();
      expect(storage.usesMemory).toBe(true);
    };

    try {
      await expect(service.installFromLocation(location, async (_extension, lifetime) => {
        expect(lifetime).toEqual({ persistent: true });
        if (timing === 'at confirmation') {
          fallBack();
        } else {
          const read = storage.getPersisted.bind(storage);
          vi.spyOn(storage, 'getPersisted').mockImplementationOnce((key, scope) => {
            const value = read(key, scope);
            fallBack();
            return value;
          });
        }
        return true;
      })).rejects.toThrow(installLifetimeChangedError);

      expect(scanner.scanUserExtensions()).toEqual([]);
      expect(database.getItems().get(storageKey(StorageScope.PROFILE, userExtensionsKey))).toBeUndefined();
      expect(active.extensions).toEqual([]);
      if (timing === 'at confirmation') {
        // Refused before it registers, so the extension never activates.
        expect(active.addExtension).not.toHaveBeenCalled();
        expect(active.removeExtension).not.toHaveBeenCalled();
      } else {
        expect(active.removeExtension).toHaveBeenCalledExactlyOnceWith('example.fixture');
      }

      const retry = vi.fn(async () => true);
      await expect(service.installFromLocation(location, retry)).resolves.toMatchObject({ location });
      expect(retry).toHaveBeenCalledExactlyOnceWith(expect.anything(), { persistent: false });
      expect(scanner.scanUserExtensions()).toEqual([expect.objectContaining({ identifier: 'example.fixture' })]);
    } finally {
      warning.mockRestore();
      vi.restoreAllMocks();
      storage.dispose();
    }
  },
);
