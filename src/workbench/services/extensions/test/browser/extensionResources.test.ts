import { expect, test, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { isValidExtensionVersion } from '../../../../../platform/extensions/common/extensionValidator.js';
import { readProductConfiguration } from '../../../../../platform/product/common/product.js';
import { readExtensionEntry, registerExtensionEntryReader, resolveExtensionEntry, resolveExtensionResource } from '../../common/extensionResources.js';
import { extensionGlobalStorageUri, extensionWorkspaceStorageUri } from '../../common/extensionStoragePaths.js';

test.each([
  ['^1.70.0', true], ['*', true], ['>=1.97.0', true], ['^2.0.0', false], ['^1.80.0-insider', true], ['1.x.x', true],
  // As in VS Code, a range below 1.0.0 accepts 1.x unless it names one exact version.
  ['^0.10.1', true], ['0.10.x', true], ['0.10.5', false], ['1.147.0', false],
] as const)(
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

test('fetches an HTTP entry and resolves HTTP resources with the spelling of their URL', async () => {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response('module.exports = {};', { headers: { 'Content-Type': 'text/javascript' } });
  });
  try {
    // The reader binds fetch when it loads.
    await import('../../../../api/common/extHostEntryReaders.js');
    const spelled = 'https://example.test/npm/@scope/a%2Fb/extension.js';
    await readExtensionEntry(URI.parse(spelled), new AbortController().signal);
    expect(requested).toEqual([spelled]);
    expect(resolveExtensionResource(URI.parse('https://example.test/npm/@scope/a%2Fb/'), 'icon.png')?.toHttpURL().href)
      .toBe('https://example.test/npm/@scope/a%2Fb/icon.png');
  } finally {
    vi.unstubAllGlobals();
  }
});
