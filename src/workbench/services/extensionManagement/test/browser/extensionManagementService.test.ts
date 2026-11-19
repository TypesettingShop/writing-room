import { expect, test, vi } from 'vitest';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { NullExtensionService } from '../../../extensions/common/extensions.js';
import { userExtensionsKey, WebExtensionsScannerService } from '../../browser/webExtensionsScannerService.js';
import { ExtensionManagementService, normalizeExtensionLocation } from '../../common/extensionManagementService.js';

const location = 'http://127.0.0.1:5000/ext/';
const manifest = { name: 'fixture', publisher: 'Example', version: '1.0.0', browser: 'entry.js' };

function setup(load: typeof fetch = async () => Response.json(manifest)) {
  const storage = new InMemoryStorageService();
  const scanner = new WebExtensionsScannerService(storage);
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
  const service = new ExtensionManagementService(fetch, scanner, active);
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
    identifier: 'example.fixture', location, installedAt: expect.any(Number), manifest,
  })]);
  await expect(service.installFromLocation(location, confirm)).rejects.toThrow('already installed');
  await expect(service.uninstall('EXAMPLE.FIXTURE')).resolves.toBe(true);
  expect(active.removeExtension).toHaveBeenCalledExactlyOnceWith('example.fixture');
  expect(storage.get(userExtensionsKey, StorageScope.PROFILE)).toBeUndefined();
});

test('starts no contribution when writing fails and restores the list when registration fails', async () => {
  const { storage, scanner, active, service } = setup();
  const write = vi.spyOn(scanner, 'write').mockRejectedValueOnce(new Error('write failed'));
  await expect(service.installFromLocation(location, async () => true)).rejects.toThrow('write failed');
  expect(active.addExtension).not.toHaveBeenCalled();
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
    const record = { identifier: 'Example.Fixture', location, manifest, installedAt: 1 };
    storage.store(userExtensionsKey, [null, { ...record, identifier: 'wrong.id' }, record], StorageScope.PROFILE, StorageTarget.USER);
    expect(scanner.scanUserExtensions()).toEqual([{ ...record, identifier: 'example.fixture' }]);
    expect(warn).toHaveBeenCalledTimes(2);
    storage.store(userExtensionsKey, 'corrupt', StorageScope.PROFILE, StorageTarget.USER);
    expect(scanner.scanUserExtensions()).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});
