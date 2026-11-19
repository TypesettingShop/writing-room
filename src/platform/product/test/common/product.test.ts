import { expect, it } from 'vitest';
import { readProductConfiguration } from '../../common/product.js';

it('keeps Open VSX defaults and supports a configured TLS gallery', () => {
  const defaults = readProductConfiguration(undefined);
  expect(defaults.extensionsGallery).toEqual({
    serviceUrl: 'https://open-vsx.org',
    allowedDownloadHosts: ['open-vsx.org', 'openvsx.eclipsecontent.org'],
  });
  expect(readProductConfiguration(JSON.stringify({
    extensionsGallery: { serviceUrl: 'https://gallery.example/catalog', allowedDownloadHosts: ['CDN.example'] },
  })).extensionsGallery).toEqual({
    serviceUrl: 'https://gallery.example/catalog', allowedDownloadHosts: ['cdn.example'],
  });
});

it('disables the gallery independently of the other product settings', () => {
  const webviewContentExternalBaseUrlTemplate = 'https://{{uuid}}.example/webview/';
  expect(readProductConfiguration(JSON.stringify({
    version: '1.90.0', extensionsGallery: null, webviewContentExternalBaseUrlTemplate,
  }))).toEqual({ version: '1.90.0', extensionsGallery: null, webviewContentExternalBaseUrlTemplate });
});

it.each(['localhost', '127.0.0.1'])('supports a configured HTTP fixture on %s', host => {
  const serviceUrl = `http://${host}:12345/openvsx`;
  const allowedDownloadHosts = ['127.0.0.1', 'localhost'];
  expect(readProductConfiguration(JSON.stringify({
    extensionsGallery: { serviceUrl, allowedDownloadHosts },
  })).extensionsGallery).toEqual({ serviceUrl, allowedDownloadHosts });
});

it.each([
  'http://example.com/openvsx', 'http://localhost.example/openvsx', 'http://127.0.0.2/openvsx',
  'http://user:secret@127.0.0.1/openvsx', 'https://user@open-vsx.org',
  'https://open-vsx.org/?private=1', 'https://open-vsx.org/#fragment', 'file:///openvsx',
])('rejects an unsupported gallery URL %s', serviceUrl => {
  expect(readProductConfiguration(JSON.stringify({ extensionsGallery: { serviceUrl } })))
    .toEqual(readProductConfiguration(undefined));
});

it('keeps the Webview origin template HTTPS requirement', () => {
  expect(readProductConfiguration(JSON.stringify({
    webviewContentExternalBaseUrlTemplate: 'http://localhost:5174/webview/', extensionsGallery: null,
  }))).toEqual(readProductConfiguration(undefined));
});
