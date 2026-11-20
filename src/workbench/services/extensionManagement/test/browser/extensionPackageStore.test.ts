// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ZipArchive } from '../../../../../base/common/zip.js';
import { URI } from '../../../../../base/common/uri.js';
import type { GalleryDownload, GalleryExtensionVersion } from '../../../../../platform/extensionManagement/common/extensionGalleryService.js';
import { createVsix, sampleManifest } from '../../../../../platform/extensionManagement/test/common/vsixTestUtils.js';
import type { IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import { BrowserFileDatabase, IndexedDBFileSystemProvider } from '../../../../../platform/files/browser/indexedDBFileSystemProvider.js';
import { FileSystemProviderError, FileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InMemoryStorageDatabase } from '../../../../../base/parts/storage/common/storage.js';
import type { IStorageUpdate } from '../../../../../base/parts/storage/common/storage.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { NullExtensionService } from '../../../extensions/common/extensions.js';
import { extensionPackageCleanupAge, ExtensionPackageStore, extensionPackagesRoot, readPackageIcon } from '../../browser/extensionPackageStore.js';
import { userExtensionsKey, WebExtensionsScannerService } from '../../browser/webExtensionsScannerService.js';
import {
  ExtensionManagementService, isPackageUrl, localizedDisplayName, normalizePackageUrl, sessionListPackageError, sha256Hex,
  usesNlsPlaceholders,
} from '../../common/extensionManagementService.js';
import type { PackageInstallConfirmation } from '../../common/extensionManagementService.js';

const location = 'vscode-userdata:/extensions/tester.sample-1.0.0/';
const folder = (name: string) => URI.from({ scheme: Schemas.vscodeUserData, path: '/extensions/' + name });
const source = { kind: 'vsix', label: 'sample.vsix' } as const;

afterEach(() => vi.restoreAllMocks());

function setup(provider = new InMemoryFileSystemProvider(), request: typeof fetch = fetch, storage = new InMemoryStorageService()) {
  let time = Date.now();
  const files = new FileService();
  files.registerProvider(Schemas.vscodeUserData, provider);
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
  const service = new ExtensionManagementService(request, scanner, active, packages);
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
  // Removing the last record is an explicit write too, so its failure stops the folder removal.
  vi.spyOn(storage, 'storeImmediately').mockImplementation((_key, value) => {
    if (typeof value === 'string') {
      throw new Error('locked');
    }
  });
  await expect(service.uninstall('tester.sample')).rejects.toThrow('locked');
  expect(active.extensions).toHaveLength(1);
  expect(await folders()).toEqual(['tester.sample-1.0.0']);
});

test('replaces a leftover folder of the same version that no record names', async () => {
  const { files, service, confirm, folders, records } = setup();
  await service.installPackage(createVsix(), source, confirm);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(files, 'del').mockRejectedValueOnce(new Error('busy'));
  await expect(service.uninstall('tester.sample')).resolves.toBe(true);
  expect(await folders()).toEqual(['tester.sample-1.0.0']);
  vi.mocked(files.del).mockRestore();

  await expect(service.installPackage(createVsix(), source, confirm)).resolves.toMatchObject({ location });
  expect(await folders()).toEqual(['tester.sample-1.0.0']);
  expect(records()).toEqual([expect.objectContaining({ location })]);
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

test('tells package URLs from folder URLs and keeps the folder URL rules for them', () => {
  expect(isPackageUrl('https://example.com/a/sample.VSIX?token=1')).toBe(true);
  expect(isPackageUrl('https://example.com/a/sample/')).toBe(false);
  expect(normalizePackageUrl('https://example.com/a/sample.vsix?token=1#x').href).toBe('https://example.com/a/sample.vsix?token=1');
  for (const value of ['http://example.com/a.vsix', 'https://user:pw@example.com/a.vsix', 'file:///a.vsix', 'https://example.com/a/']) {
    expect(() => normalizePackageUrl(value), value).toThrow();
  }
});

test('installs the downloaded bytes of a package URL, fetched without credentials or redirects, once per package', async () => {
  const bytes = createVsix();
  const request = vi.fn(async () => new Response(bytes));
  const { service, confirm, confirmations, records } = setup(undefined, request);
  const url = 'http://127.0.0.1:5000/packages/sample.vsix?v=1';
  const [first, second] = await Promise.all([service.installFromPackageUrl(url, confirm), service.installFromPackageUrl(url, confirm)]);
  expect(first).toBe(second);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledWith(new URL(url), expect.objectContaining({ credentials: 'omit', redirect: 'error', mode: 'cors' }));
  expect(confirmations).toEqual([expect.objectContaining({
    source: { kind: 'vsix', label: 'http://127.0.0.1:5000/packages/sample.vsix' }, sha256: await sha256Hex(bytes),
  })]);
  expect(records()).toEqual([expect.objectContaining({ packageSha256: await sha256Hex(bytes) })]);
});

test('stops a package download at 50 MiB and reports unreachable servers', async () => {
  const cancel = vi.fn();
  let chunks = 0;
  const large = setup(undefined, async () => new Response(new ReadableStream({
    pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel,
  })));
  await expect(large.service.installFromPackageUrl('https://example.com/a.vsix', large.confirm)).rejects.toThrow('exceeds 52428800 bytes');
  expect(cancel).toHaveBeenCalledOnce();
  expect(chunks).toBeLessThan(53);
  const offline = setup(undefined, async () => { throw new TypeError('Failed to fetch'); });
  await expect(offline.service.installFromPackageUrl('https://example.com/a.vsix', offline.confirm)).rejects.toThrow(/Cannot download the package/);
  expect(large.confirm).not.toHaveBeenCalled();
});

test('reads localized manifest strings only for manifests with placeholders', async () => {
  expect(usesNlsPlaceholders({ ...sampleManifest, displayName: '%name%' })).toBe(true);
  expect(usesNlsPlaceholders({ ...sampleManifest, displayName: '100% done' })).toBe(false);
  expect(localizedDisplayName({ ...sampleManifest, displayName: '%name%' }, { name: 'Sample' })).toBe('Sample');
  expect(localizedDisplayName({ ...sampleManifest, displayName: '%name%' }, undefined)).toBe('%name%');

  const location = 'http://127.0.0.1:5000/folder/';
  const plain = vi.fn(async () => Response.json({ ...sampleManifest }));
  const first = setup(undefined, plain);
  await first.service.installFromLocation(location, async () => true);
  expect(plain).toHaveBeenCalledOnce();
  expect(first.records()[0].nls).toBeUndefined();

  const localized = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('package.nls.json')
    ? Response.json({ name: { message: 'Sample' } }) : Response.json({ ...sampleManifest, displayName: '%name%' }));
  const second = setup(undefined, localized as typeof fetch);
  const description = await second.service.installFromLocation(location, async () => true);
  expect(localized.mock.calls.map(([input]) => String(input))).toEqual([location + 'package.json', location + 'package.nls.json']);
  expect(description?.nls).toEqual({ name: 'Sample' });
  expect(second.records()[0].nls).toEqual({ name: 'Sample' });

  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const missing = setup(undefined, (async (input: RequestInfo | URL) => String(input).endsWith('package.nls.json')
    ? new Response('', { status: 404 }) : Response.json({ ...sampleManifest, displayName: '%name%' })) as typeof fetch);
  await missing.service.installFromLocation(location, async () => true);
  expect(missing.records()[0].nls).toBeUndefined();
});

test('runs a removal asked for during an install after that install, so nothing is left half registered', async () => {
  const { files, service, confirm, folders, records, active } = setup();
  await service.installPackage(createVsix(), source, confirm);
  const original = files.writeFile.bind(files);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const staging = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(files, 'writeFile').mockImplementation(async (...args) => {
    started();
    await gate;
    return original(...args);
  });
  const install = service.installPackage(createVsix({ manifest: { ...sampleManifest, version: '1.1.0' } }), source, confirm);
  await staging;
  const removal = service.uninstall('tester.sample');
  release();
  await install;
  await expect(removal).resolves.toBe(true);
  expect(active.extensions).toEqual([]);
  expect(records()).toEqual([]);
  expect(await folders()).toEqual([]);
});

test('keeps the record of a reinstall whose registration fails, as it matches the replaced files', async () => {
  const { files, service, confirm, folders, records, active } = setup();
  await service.installPackage(createVsix(), source, confirm);
  active.addExtension.mockReturnValueOnce(false);
  const again = createVsix({ manifest: { ...sampleManifest, description: 'again' }, files: { 'dist/web.js': 'changed' } });
  await expect(service.installPackage(again, source, confirm)).rejects.toThrow('loads after a reload');
  expect(records()).toEqual([expect.objectContaining({ packageSha256: await sha256Hex(again), manifest: expect.objectContaining({ description: 'again' }) })]);
  expect(await folders()).toEqual(['tester.sample-1.0.0']);
  expect(new TextDecoder().decode((await files.readFile(URI.parse(location + 'dist/web.js'))).value)).toBe('changed');
});

test('unpacks each file once even when the confirmation read its localized strings', async () => {
  const { service, confirm } = setup();
  const read = vi.spyOn(ZipArchive.prototype, 'read');
  await service.installPackage(createVsix({
    manifest: { ...sampleManifest, displayName: '%displayName%' },
    files: { 'dist/web.js': '', 'package.nls.json': JSON.stringify({ displayName: 'Sample' }) },
  }), source, confirm);
  const paths = read.mock.calls.map(([entry]) => entry.path);
  expect(paths.filter(path => path === 'extension/package.nls.json')).toHaveLength(1);
  expect(paths.filter(path => path === 'extension/dist/web.js')).toHaveLength(1);
});

test.each(['1.0.0', '1.1.0'])('waits for the old generation before writing replacement %s', async version => {
  const { files, service, confirm, records, active } = setup();
  await service.installPackage(createVsix(), source, confirm);
  const previous = records()[0];
  const deactivate = vi.fn(async () => {
    expect(records()[0]?.packageSha256).toBe(previous.packageSha256);
    expect(new TextDecoder().decode((await files.readFile(URI.parse(location + 'dist/web.js'))).value))
      .toBe('exports.activate = () => {};\n');
  });
  Object.assign(active, { whenExtensionRemoved: deactivate });
  const replacement = createVsix({ manifest: { ...sampleManifest, version }, files: { 'dist/web.js': 'replacement' } });
  await service.installPackage(replacement, source, confirm);
  expect(deactivate).toHaveBeenCalledOnce();
  expect(records()[0]?.packageSha256).toBe(await sha256Hex(replacement));
});


const galleryRelease: GalleryExtensionVersion = {
  id: 'tester.sample', namespace: 'tester', name: 'sample', version: '1.0.0',
  displayName: 'Sample', description: '', downloadCount: 0, verifiedPublisher: false,
  isWebExtension: true, dependencies: [], hasExtensionPack: false,
  download: 'https://registry.example/api/tester/sample/file/sample.vsix',
  sha256: 'https://registry.example/api/tester/sample/file/sample.sha256',
};

async function verifiedDownload(bytes: Uint8Array<ArrayBuffer>): Promise<GalleryDownload> {
  return { bytes, sha256: await sha256Hex(bytes), signature: { state: 'verified', keyId: 'sample-key' }, host: 'cdn.example' };
}

test.each([
  ['identifier', { id: 'tester.other' }],
  ['version', { version: '2.0.0' }],
] as const)('rejects a gallery %s that disagrees with the actual package', async (_field, release) => {
  const { service, confirm, records, folders } = setup();
  await expect(service.installFromGallery({ ...galleryRelease, ...release }, await verifiedDownload(createVsix()), confirm))
    .rejects.toThrow(/package identifier or version/);
  expect(confirm).not.toHaveBeenCalled();
  expect(records()).toEqual([]);
  expect(await folders()).toEqual([]);
});

test.each([
  { metadata: ['dep'], manifest: [] },
  { metadata: [], manifest: ['tester.dep'] },
])('rejects differing gallery and package dependency sets (%o)', async ({ metadata, manifest }) => {
  const { service, confirm, records, folders } = setup();
  const release = { ...galleryRelease, dependencies: metadata.map(name => ({ namespace: 'tester', name })) };
  const download = await verifiedDownload(createVsix({ manifest: { ...sampleManifest, extensionDependencies: manifest } }));
  await expect(service.installFromGallery(release, download, confirm)).rejects.toThrow(/package dependencies do not match/);
  expect(confirm).not.toHaveBeenCalled();
  expect(records()).toEqual([]);
  expect(await folders()).toEqual([]);
});

test('checks the actual installation bytes again against the gallery digest', async () => {
  const { service, confirm, records, folders } = setup();
  const download = await verifiedDownload(createVsix());
  const replacement = createVsix({ manifest: { ...sampleManifest, displayName: 'Replaced bytes' } });
  await expect(service.installFromGallery(galleryRelease, { ...download, bytes: replacement }, confirm))
    .rejects.toThrow(/package bytes no longer match/);
  expect(confirm).not.toHaveBeenCalled();
  expect(records()).toEqual([]);
  expect(await folders()).toEqual([]);
});

test('local confirmation of the same bytes cannot settle a pending gallery install', async () => {
  const { service, records } = setup();
  const download = await verifiedDownload(createVsix());
  const localPrompt = new DeferredPromise<void>();
  const localAnswer = new DeferredPromise<boolean>();
  const local = service.installPackage(download.bytes, source, async () => {
    await localPrompt.complete();
    return localAnswer.p;
  });
  await localPrompt.p;
  const galleryAnswer = vi.fn(async () => true);
  const gallery = service.installFromGallery(galleryRelease, download, galleryAnswer);
  try {
    await vi.waitFor(() => expect(galleryAnswer).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ kind: 'gallery', label: 'registry.example', host: 'cdn.example' }),
      signature: 'verified',
    })));
    await gallery;
    expect(records()).toEqual([expect.objectContaining({ source: 'gallery', signature: 'verified' })]);
  } finally {
    await localAnswer.complete(false);
    await Promise.allSettled([local, gallery]);
  }
});

test('checks dependencies in the installed-list lock after staging', async () => {
  const { service, scanner, packages, active, confirm, records, folders } = setup();
  await service.installPackage(createVsix({ manifest: { ...sampleManifest, name: 'dep' } }), source, confirm);

  const stage = packages.stage.bind(packages);
  vi.spyOn(packages, 'stage').mockImplementationOnce(async (...args) => {
    const staged = await stage(...args);
    // Another tab drops the record after we have confirmed and staged the package. The live list is stale.
    await scanner.locked(async (read, write) => write(read().filter(record => record.identifier !== 'tester.dep')));
    return staged;
  });
  const release = { ...galleryRelease, dependencies: [{ namespace: 'tester', name: 'dep' }] };
  const download = await verifiedDownload(createVsix({ manifest: { ...sampleManifest, extensionDependencies: ['tester.dep'] } }));
  await expect(service.installFromGallery(release, download, confirm)).rejects.toThrow(/tester.dep.*no longer installed/);
  expect(active.extensions.map(extension => extension.identifier.value)).toEqual(['tester.dep']);
  expect(records()).toEqual([]);
  expect(await folders()).toEqual(['tester.dep-1.0.0']);
});

test('a package reinstall waits for queued removal before deciding which version is installed', async () => {
  const { service, active, records, confirm } = setup();
  const bytes = createVsix({ vsixManifest: null, manifest: null, files: {},
    entries: [{ name: 'extension/package.json', method: 'store', data: JSON.stringify(sampleManifest) },
      { name: 'extension/dist/web.js', method: 'store', data: 'exports.activate = () => {};' }],
  });
  await service.installPackage(bytes, source, confirm);
  const removing = new DeferredPromise<void>();
  const deactivated = new DeferredPromise<void>();
  Object.assign(active, { whenExtensionRemoved: async () => {
    await removing.complete();
    await deactivated.p;
  } });
  const removal = service.uninstall('tester.sample');
  await removing.p;

  const opened = new DeferredPromise<void>();
  const open = ZipArchive.open.bind(ZipArchive);
  vi.spyOn(ZipArchive, 'open').mockImplementationOnce((...args) => {
    void opened.complete();
    return open(...args);
  });
  const reinstallConfirm = vi.fn(async (_confirmation: PackageInstallConfirmation) => true);
  const reinstall = service.installPackage(bytes, source, reinstallConfirm);
  try {
    await opened.p;
    // The stored manifest above is decoded in microtasks after open. Keep deactivation pending until those settle.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(reinstallConfirm).not.toHaveBeenCalled();
  } finally {
    await deactivated.complete();
    await Promise.allSettled([removal, reinstall]);
  }
  await expect(reinstall).resolves.toMatchObject({ location });
  expect(reinstallConfirm).toHaveBeenCalledWith(expect.objectContaining({ existing: undefined }));
  expect(records()).toEqual([expect.objectContaining({ identifier: 'tester.sample' })]);
});

/** A storage backend that cannot be opened, or that starts failing writes, putting the storage in memory mode. */
class FallibleDatabase extends InMemoryStorageDatabase {
  failWrite = false;

  constructor(private readonly failOpen = false) {
    super();
  }

  override getItems(): Map<string, string> {
    if (this.failOpen) {
      throw new Error('access denied');
    }
    return super.getItems();
  }

  override updateItems(update: IStorageUpdate): void {
    if (this.failWrite) {
      throw new Error('quota exceeded');
    }
    super.updateItems(update);
  }
}

/** Session-only files: the user data database cannot be opened. */
function sessionFiles() {
  return new IndexedDBFileSystemProvider(new BrowserFileDatabase(() => Promise.reject(new Error('blocked')), () => {}), Schemas.vscodeUserData);
}

/** Makes the workbench storage fall back to memory, as a failed background write does. */
function fallBack(storage: InMemoryStorageService, database: FallibleDatabase): void {
  database.failWrite = true;
  storage.store('unrelated', 'value', StorageScope.PROFILE, StorageTarget.USER);
  void storage.flush();
  expect(storage.usesMemory).toBe(true);
}

test('in a window that blocks storage, a package installs, runs and uninstalls for the session', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = new InMemoryStorageService(new FallibleDatabase(true));
  const { service, confirm, confirmations, folders, records, active } = setup(sessionFiles() as never, fetch, storage);
  const immediate = vi.spyOn(storage, 'storeImmediately');

  await expect(service.installPackage(createVsix(), source, confirm)).resolves.toMatchObject({ location });
  expect(confirmations[0].persistent).toBe(false);
  expect(await folders()).toEqual(['tester.sample-1.0.0']);
  expect(records()).toEqual([expect.objectContaining({ location })]);
  expect(active.extensions.map(extension => extension.location)).toEqual([location]);

  await expect(service.uninstall('tester.sample')).resolves.toBe(true);
  expect(records()).toEqual([]);
  expect(await folders()).toEqual([]);
  expect(active.extensions).toEqual([]);

  await expect(service.installPackage(createVsix(), source, confirm)).resolves.toMatchObject({ location });
  expect(await folders()).toEqual(['tester.sample-1.0.0']);
  expect(immediate).not.toHaveBeenCalled();
});

test('refuses a package before the confirmation when only the installed list is session-only', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = new InMemoryStorageService(new FallibleDatabase(true));
  const { service, confirm, folders, records, active } = setup(undefined, fetch, storage);
  await expect(service.installPackage(createVsix(), source, confirm)).rejects.toThrow(sessionListPackageError);
  expect(confirm).not.toHaveBeenCalled();
  expect(await folders()).toEqual([]);
  expect(records()).toEqual([]);
  expect(active.addExtension).not.toHaveBeenCalled();
});

test('refuses to move the package into persistent files when the storage falls back after the confirmation', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const database = new FallibleDatabase();
  const storage = new InMemoryStorageService(database);
  const { service, folders, records, active } = setup(undefined, fetch, storage);
  const confirm = vi.fn(async (confirmation: PackageInstallConfirmation) => {
    expect(confirmation.persistent).toBe(true);
    fallBack(storage, database);
    return true;
  });
  await expect(service.installPackage(createVsix(), source, confirm)).rejects.toThrow(sessionListPackageError);
  expect(confirm).toHaveBeenCalledOnce();
  expect(await folders()).toEqual([]);
  expect(records()).toEqual([]);
  expect(active.addExtension).not.toHaveBeenCalled();
});

test('an uninstall after the storage fell back keeps the persistent package folder', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const database = new FallibleDatabase();
  const storage = new InMemoryStorageService(database);
  const { service, confirm, folders, records, active } = setup(undefined, fetch, storage);
  await service.installPackage(createVsix(), source, confirm);
  fallBack(storage, database);

  await expect(service.uninstall('tester.sample')).resolves.toBe(true);
  expect(records()).toEqual([]);
  expect(active.extensions).toEqual([]);
  expect(await folders()).toEqual(['tester.sample-1.0.0']);
  expect(database.getItems().get(`${StorageScope.PROFILE}:${userExtensionsKey}`)).toContain(location);
});
