import { expect, test } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { isValidExtensionVersion } from '../../../../../platform/extensions/common/extensionValidator.js';
import { readProductConfiguration } from '../../../../../platform/product/common/product.js';
import { readExtensionEntry, registerExtensionEntryReader, resolveExtensionEntry, resolveExtensionResource } from '../../common/extensionResources.js';
import { extensionGlobalStorageUri, extensionWorkspaceStorageUri } from '../../common/extensionStoragePaths.js';

test.each([['^1.70.0', true], ['*', true], ['>=1.97.0', true], ['^2.0.0', false]] as const)(
  'checks engine %s against the product API', (range, compatible) => {
    expect(isValidExtensionVersion('1.148.0', range)).toBe(compatible);
  },
);

test('applies validated product fields together and uses defaults for an invalid override', () => {
  const config = readProductConfiguration(JSON.stringify({
    extensionsGallery: { allowedDownloadHosts: ['example.com'] },
    webviewContentExternalBaseUrlTemplate: 'https://{uuid}.example.com/',
  }));
  expect(config).toMatchObject({
    version: '1.148.0',
    extensionsGallery: { serviceUrl: 'https://open-vsx.org', allowedDownloadHosts: ['example.com'] },
    webviewContentExternalBaseUrlTemplate: 'https://{uuid}.example.com/',
  });
  expect(readProductConfiguration('{"extensionsGallery":{"serviceUrl":"file:///bad"}}'))
    .toEqual(readProductConfiguration(undefined));
});

test('keeps resources inside extension folders and normalizes the entry file suffix', async () => {
  const base = 'vscode-userdata:/extensions/example.test/';
  expect(resolveExtensionEntry(base, './dist/browser/extension')?.href).toBe(base + 'dist/browser/extension.js');
  expect(resolveExtensionEntry(base, './main.js')?.href).toBe(base + 'main.js');
  expect(resolveExtensionResource(URI.parse(base), 'one/../asset.png')?.toString()).toBe(base + 'asset.png');
  expect(resolveExtensionResource(URI.parse(base), '../outside')).toBeUndefined();
  expect(resolveExtensionResource(URI.parse(base), 'a%2fb')).toBeUndefined();
  const entry = URI.parse('test-reader:/extension.js');
  registerExtensionEntryReader('test-reader', async resource => new TextEncoder().encode(resource.path));
  expect(new TextDecoder().decode(await readExtensionEntry(entry, new AbortController().signal))).toBe('/extension.js');
  expect(extensionGlobalStorageUri('Publisher.Name').path).toBe('/User/globalStorage/publisher.name');
  expect(extensionWorkspaceStorageUri('workspace-id', 'Publisher.Name').path)
    .toBe('/User/workspaceStorage/workspace-id/publisher.name');
  expect(() => extensionWorkspaceStorageUri('../bad', 'Publisher.Name')).toThrow('Invalid extension storage path');
});
