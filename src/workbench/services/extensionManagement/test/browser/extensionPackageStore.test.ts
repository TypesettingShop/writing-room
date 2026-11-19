// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { createVsix, sampleManifest } from '../../../../../platform/extensionManagement/test/common/vsixTestUtils.js';
import type { IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import { BrowserFileDatabase, IndexedDBFileSystemProvider } from '../../../../../platform/files/browser/indexedDBFileSystemProvider.js';
import { FileSystemProviderError, FileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { NullExtensionService } from '../../../extensions/common/extensions.js';
import { extensionPackageCleanupAge, ExtensionPackageStore, extensionPackagesRoot, readPackageIcon } from '../../browser/extensionPackageStore.js';
import { userExtensionsKey, WebExtensionsScannerService } from '../../browser/webExtensionsScannerService.js';
import { ExtensionManagementService, sha256Hex } from '../../common/extensionManagementService.js';
import type { PackageInstallConfirmation } from '../../common/extensionManagementService.js';

const location = 'vscode-userdata:/extensions/tester.sample-1.0.0/';
const folder = (name: string) => URI.from({ scheme: Schemas.vscodeUserData, path: '/extensions/' + name });
const source = { kind: 'vsix', label: 'sample.vsix' } as const;

afterEach(() => vi.restoreAllMocks());

function setup(provider = new InMemoryFileSystemProvider()) {
  let time = Date.now();
  const files = new FileService();
  files.registerProvider(Schemas.vscodeUserData, provider);
  const storage = new InMemoryStorageService();
  const scanner = new WebExtensionsScannerService(null, storage);
  const packages = new ExtensionPackageStore(() => time, files);
  const extensions: IExtensionDescription[] = [];
  const active = Object.assign(new NullExtensionService(), {
    extensions,
    addExtension: vi.fn((extension: IExtensionDescription) => {
      extensions.push(extension);
      return true;
    }),
    removeExtension: vi.fn((id: string) => {
      const index = extensions.findIndex(extension => extension.identifier.value === id);
      return index >= 0 && extensions.splice(index, 1).length === 1;
    }),
  });
  const service = new ExtensionManagementService(fetch, scanner, active, packages);
  const confirmations: PackageInstallConfirmation[] = [];
  const confirm = vi.fn(async (confirmation: PackageInstallConfirmation) => {
    confirmations.push(confirmation);
    return true;
  });
  const folders = async () => (await files.exists(extensionPackagesRoot))
    ? ((await files.resolve(extensionPackagesRoot)).children ?? []).map(child => child.name).sort() : [];
  const records = () => scanner.scanUserExtensions();
  const advance = (milliseconds: number) => { time += milliseconds; };
  return { files, storage, scanner, packages, active, service, confirm, confirmations, folders, records, advance };
}

test('installs the confirmed bytes into the package folder and records them', async () => {
  const { files, service, confirm, confirmations, folders, records, active } = setup();
  const bytes = createVsix({ manifest: { ...sampleManifest, displayName: 'Sample' } });
  const description = await service.installPackage(bytes, source, confirm);

  expect(confirmations).toEqual([expect.objectContaining({
    identifier: 'tester.sample', source, size: bytes.byteLength, sha256: await sha256Hex(bytes), signature: 'unsigned',
    engine: '^1.80.0', isWebExtension: true, existing: undefined, persistent: true,
  })]);
  expect(description).toMatchObject({ location, isBuiltin: false });
  expect(active.extensions).toEqual([description]);
  expect(await folders()).toEqual(['tester.sample-1.0.0']);
  expect(new TextDecoder().decode((await files.readFile(URI.parse(location + 'dist/web.js'))).value))
    .toBe('exports.activate = () => {};\n');
  expect(records()).toEqual([expect.objectContaining({
    identifier: 'tester.sample', location, source: 'vsix', version: '1.0.0', packageSha256: await sha256Hex(bytes), signature: 'unsigned',
  })]);
});

test('writes nothing when the confirmation is cancelled', async () => {
  const { files, storage, service, folders } = setup();
  await expect(service.installPackage(createVsix(), source, async () => false)).resolves.toBeUndefined();
  expect(await folders()).toEqual([]);
  expect(await files.exists(extensionPackagesRoot)).toBe(false);
  expect(storage.get(userExtensionsKey, StorageScope.PROFILE)).toBeUndefined();
});

test.each([
  ['unpacking', 'writeFile'],
  ['the rename', 'move'],
] as const)('leaves neither a record nor a folder when %s fails', async (_step, method) => {
  const { files, service, confirm, folders, records, active } = setup();
  const original = files[method].bind(files) as (...args: unknown[]) => Promise<unknown>;
  let calls = 0;
  vi.spyOn(files, method).mockImplementation((async (...args: unknown[]) => {
    if (++calls === 2 || method === 'move') {
      throw new Error(method + ' failed');
    }
    return original(...args);
  }) as never);
  await expect(service.installPackage(createVsix({ files: { 'dist/web.js': 'a', 'other.js': 'b' } }), source, confirm))
    .rejects.toThrow(method + ' failed');
  expect(await folders()).toEqual([]);
  expect(records()).toEqual([]);
  expect(active.addExtension).not.toHaveBeenCalled();
});

test('removes the renamed folder when the list cannot be written', async () => {
  const { storage, service, confirm, folders, records } = setup();
  vi.spyOn(storage, 'storeImmediately').mockImplementation((_key, value) => {
    if (typeof value === 'string') {
      throw new Error('quota');
    }
  });
  await expect(service.installPackage(createVsix(), source, confirm)).rejects.toThrow('quota');
  expect(await folders()).toEqual([]);
  expect(records()).toEqual([]);
});

test('removes the record and the folder when registration fails', async () => {
  const { service, confirm, folders, records, active } = setup();
  active.addExtension.mockReturnValueOnce(false);
  await expect(service.installPackage(createVsix(), source, confirm)).rejects.toThrow('Could not register');
  expect(await folders()).toEqual([]);
  expect(records()).toEqual([]);
});

test('reports the needed size and removes the temporary folder when storage is full', async () => {
  const { files, service, confirm, folders } = setup();
  vi.spyOn(files, 'writeFile').mockRejectedValue(new FileSystemProviderError('full', FileSystemProviderErrorCode.FileExceedsStorageQuota));
  const bytes = createVsix({ files: { 'dist/web.js': 'x'.repeat(1000) } });
  await expect(service.installPackage(bytes, source, confirm)).rejects.toThrow(/Not enough browser storage for 'tester\.sample': its files need \d+ bytes/);
  expect(await folders()).toEqual([]);
});

test('cleans up interrupted installs older than an hour and keeps younger ones of other tabs', async () => {
  const { packages, folders, advance } = setup();
  const { readVsix } = await import('../../../../../platform/extensionManagement/common/extensionManagementUtil.js');
  // An install that stopped after unpacking and one that stopped after the rename.
  await packages.stage(await readVsix(createVsix({ manifest: { ...sampleManifest, name: 'unpacked' } })));
  await packages.commit(await packages.stage(await readVsix(createVsix({ manifest: { ...sampleManifest, name: 'renamed' } }))), false);
  const recorded = await packages.commit(await packages.stage(await readVsix(createVsix())), false);
  const before = await folders();
  expect(before).toEqual([expect.stringMatching(/^\.tmp-/), 'tester.renamed-1.0.0', 'tester.sample-1.0.0']);

  advance(extensionPackageCleanupAge - 60_000);
  await packages.cleanup(new Set([recorded]));
  expect(await folders()).toEqual(before);

  advance(120_000);
  await packages.cleanup(new Set([recorded]));
  expect(await folders()).toEqual(['tester.sample-1.0.0']);
});

test('uninstall removes the record before the folder, and replacing a version removes the old folder', async () => {
  const { service, confirm, confirmations, folders, records, active } = setup();
  await service.installPackage(createVsix(), source, confirm);
  const next = createVsix({ manifest: { ...sampleManifest, version: '1.1.0' } });
  await service.installPackage(next, source, confirm);
  expect(confirmations[1].existing).toEqual({ version: '1.0.0', source: 'vsix' });
  expect(await folders()).toEqual(['tester.sample-1.1.0']);
  expect(records()).toEqual([expect.objectContaining({ version: '1.1.0', location: 'vscode-userdata:/extensions/tester.sample-1.1.0/' })]);
  expect(active.extensions.map(extension => extension.location)).toEqual(['vscode-userdata:/extensions/tester.sample-1.1.0/']);

  await service.installPackage(createVsix({ manifest: { ...sampleManifest, version: '1.1.0', description: 'again' } }), source, confirm);
  expect(confirmations[2].existing).toEqual({ version: '1.1.0', source: 'vsix' });
  expect(await folders()).toEqual(['tester.sample-1.1.0']);
  expect(records()).toEqual([expect.objectContaining({ manifest: expect.objectContaining({ description: 'again' }) })]);

  await expect(service.uninstall('tester.sample')).resolves.toBe(true);
  expect(records()).toEqual([]);
  expect(await folders()).toEqual([]);
  expect(active.extensions).toEqual([]);
});

test('keeps the extension registered when the uninstall cannot write the list', async () => {
  const { storage, service, confirm, folders, active } = setup();
  await service.installPackage(createVsix(), source, confirm);
  vi.spyOn(storage, 'flush').mockRejectedValueOnce(new Error('locked'));
  await expect(service.uninstall('tester.sample')).rejects.toThrow('locked');
  expect(active.extensions).toHaveLength(1);
  expect(await folders()).toEqual(['tester.sample-1.0.0']);
});

test('refuses an install when another window changed the record after the confirmation', async () => {
  const { scanner, service, folders, records } = setup();
  const record = {
    identifier: 'tester.sample', location: 'http://127.0.0.1:5000/sample/', manifest: sampleManifest,
    installedAt: 1, source: 'location', version: '1.0.0',
  } as const;
  await expect(service.installPackage(createVsix(), source, async () => {
    await scanner.locked(async (_read, write) => write([record]));
    return true;
  })).rejects.toThrow('changed in another window');
  expect(records()).toEqual([record]);
  expect(await folders()).toEqual([]);
});

test.each([
  ['an incompatible engine', { manifest: { ...sampleManifest, engines: { vscode: '^2.0.0' } } }, /requires VS Code \^2\.0\.0/],
  ['no engine', { manifest: { ...sampleManifest, engines: undefined } }, /does not declare engines\.vscode/],
  ['a missing entry', { files: { 'other.js': 'x' } }, /browser entry '\.\/dist\/web\.js'.*is not in the package/],
  ['an oversized entry', { files: { 'dist/web.js': new Uint8Array(16 * 1024 * 1024 + 1) } }, /more than the 16777216-byte limit/],
  ['a platform package', { targetPlatform: 'linux-x64' }, /platform/i],
] as const)('rejects %s before the confirmation', async (_name, options, message) => {
  const { service, confirm, folders, records } = setup();
  await expect(service.installPackage(createVsix(options), source, confirm)).rejects.toThrow(message);
  expect(confirm).not.toHaveBeenCalled();
  expect(await folders()).toEqual([]);
  expect(records()).toEqual([]);
});

test('reads package.nls.json and the display language into the record', async () => {
  const { service, confirm, records } = setup();
  await service.installPackage(createVsix({
    manifest: { ...sampleManifest, displayName: '%displayName%' },
    files: {
      'dist/web.js': '', 'package.nls.json': JSON.stringify({ displayName: 'Sample', other: { message: 'Other', comment: ['x'] } }),
      'package.nls.ko.json': JSON.stringify({ displayName: '견본' }),
    },
  }), source, confirm, { language: 'ko' });
  expect(records()[0].nls).toEqual({ displayName: '견본', other: 'Other' });
});

test('merges a second install of the same bytes into the one in progress', async () => {
  const { service, confirm } = setup();
  const bytes = createVsix();
  const [first, second] = await Promise.all([service.installPackage(bytes, source, confirm), service.installPackage(bytes, source, confirm)]);
  expect(first).toBe(second);
  expect(confirm).toHaveBeenCalledOnce();
});

test('tells the confirmation when files are kept for this session only', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const database = new BrowserFileDatabase(() => Promise.reject(new Error('blocked')), () => {});
  const { service, confirm, confirmations } = setup(new IndexedDBFileSystemProvider(database, Schemas.vscodeUserData) as never);
  await service.installPackage(createVsix(), source, confirm);
  expect(confirmations[0].persistent).toBe(false);
});

test('reads package icons up to 256 KiB from package folders only', async () => {
  const { files } = setup();
  await files.writeFile(folder('tester.sample-1.0.0/icon.png'), new Uint8Array([1, 2, 3]));
  await files.writeFile(folder('tester.sample-1.0.0/large.png'), new Uint8Array(256 * 1024 + 1));
  await files.writeFile(URI.from({ scheme: Schemas.vscodeUserData, path: '/User/globalStorage/x/icon.png' }), new Uint8Array(1));
  const signal = new AbortController().signal;
  await expect(readPackageIcon(files, new URL(location + 'icon.png'), 256 * 1024, signal))
    .resolves.toEqual({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
  await expect(readPackageIcon(files, new URL(location + 'large.png'), 256 * 1024, signal)).rejects.toThrow();
  await expect(readPackageIcon(files, new URL('vscode-userdata:/User/globalStorage/x/icon.png'), 256 * 1024, signal))
    .rejects.toThrow('not inside an extension package folder');
  await expect(readPackageIcon(files, new URL(location + '../../User/globalStorage/x/icon.png'), 256 * 1024, signal))
    .rejects.toThrow('not inside an extension package folder');
});
