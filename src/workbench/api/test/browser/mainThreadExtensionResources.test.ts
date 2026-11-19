// @vitest-environment node
import { expect, test } from 'vitest';
import { TransferableBuffer } from '../../../../base/common/marshalling.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { findPackageEntry, MainThreadExtensionResources } from '../../browser/mainThreadExtensionResources.js';

const extension = (name: string, location: string, browser = 'dist/web.js', isBuiltin = false): IExtensionDescription => ({
  identifier: new ExtensionIdentifier('tester.' + name), location, isBuiltin,
  manifest: { name, publisher: 'tester', version: '1.0.0', browser },
});
const sample = 'vscode-userdata:/extensions/tester.sample-1.0.0/';
const extensions = [
  extension('sample', sample),
  extension('remote', 'http://127.0.0.1:5000/remote/'),
  extension('noext', 'vscode-userdata:/extensions/tester.noext-1.0.0/', 'main'),
];

test('reads only the exact entry of a registered package extension', () => {
  expect(findPackageEntry(extensions, sample + 'dist/web.js')).toBe('/extensions/tester.sample-1.0.0/dist/web.js');
  expect(findPackageEntry(extensions, 'vscode-userdata:/extensions/tester.noext-1.0.0/main.js')).toBe('/extensions/tester.noext-1.0.0/main.js');
  for (const entry of [
    sample + 'package.json',
    sample + 'dist/../package.json',
    sample + 'dist/web.js/../../../../User/globalStorage/tester.sample/web.js',
    sample + 'dist%2Fweb.js',
    sample + 'dist/web.js?x',
    'vscode-userdata://host/extensions/tester.sample-1.0.0/dist/web.js',
    'vscode-vfs://writing-room/extensions/tester.sample-1.0.0/dist/web.js',
    'http://127.0.0.1:5000/remote/dist/web.js',
    'vscode-userdata:/extensions/tester.other-1.0.0/dist/web.js',
  ]) {
    expect(findPackageEntry(extensions, entry), entry).toBeUndefined();
  }
  expect(findPackageEntry([extension('sample', sample, 'dist/web.js', true)], sample + 'dist/web.js')).toBeUndefined();
});

test('reads the entry from user data up to 16 MiB', async () => {
  const files = new FileService();
  files.registerProvider(Schemas.vscodeUserData, new InMemoryFileSystemProvider());
  const resources = new MainThreadExtensionResources(() => extensions, files);
  const entry = URI.parse(sample + 'dist/web.js');
  await files.writeFile(entry, new TextEncoder().encode('exports.activate = () => {};'));
  const result = await resources.$readPackageEntry(sample + 'dist/web.js') as unknown;
  expect(result).toBeInstanceOf(TransferableBuffer);
  expect(new TextDecoder().decode((result as TransferableBuffer).bytes)).toBe('exports.activate = () => {};');

  await files.writeFile(entry, new Uint8Array(16 * 1024 * 1024 + 1));
  await expect(resources.$readPackageEntry(sample + 'dist/web.js')).rejects.toThrow();
  await expect(resources.$readPackageEntry(sample + 'package.json')).rejects.toThrow('not the entry of an installed extension package');
  await expect(resources.$readPackageEntry({ toString: () => sample + 'dist/web.js' })).rejects.toThrow();
});
