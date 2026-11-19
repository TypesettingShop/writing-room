import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createZip } from '../../../../base/test/common/zipTestUtils.js';
import { ExtensionGalleryService, GalleryRateLimitError } from '../../common/extensionGalleryService.js';

const origin = 'https://open-vsx.org';
const cdn = 'https://openvsx.eclipsecontent.org';
const versionPath = '/api/test/gallery/1.0.0';
const assets = versionPath + '/file/';
const keyPath = '/api/-/public-key/a-key';
const config = { serviceUrl: origin, allowedDownloadHosts: ['open-vsx.org', 'openvsx.eclipsecontent.org'] };
const id = { namespace: 'Test', name: 'Gallery' };
const bytes = new Uint8Array([12, 30, 90]);
const goodHash = createHash('sha256').update(bytes).digest('hex');
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const signature = sign(null, bytes, keys.privateKey);

afterEach(() => vi.restoreAllMocks());

function fixture(options: {
  unsigned?: boolean; checksum?: string; signature?: Uint8Array; key?: string;
  web?: boolean; bundle?: Uint8Array<ArrayBuffer>; metadata?: Record<string, unknown>;
} = {}) {
  const summary = { name: 'gallery', namespace: 'test', version: '1.0.0', displayName: 'Test Gallery', verified: true };
  const metadata = {
    ...summary, extensionKind: [options.web === false ? 'workspace' : 'web'],
    files: {
      download: origin + assets + 'gallery.vsix', sha256: origin + assets + 'gallery.sha256',
      ...options.unsigned ? {} : { signature: origin + assets + 'gallery.sigzip', publicKey: origin + keyPath },
    },
    ...options.metadata,
  };
  const request = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    switch (url.pathname.toLowerCase()) {
      case '/api/test/gallery':
      case versionPath:
        return Response.json(metadata);
      case '/api/-/search':
        return Response.json({ offset: 0, totalSize: 25, extensions: [summary, { ...summary, name: {} }, { ...summary, displayName: 'a'.repeat(257) },
          ...Array.from({ length: 17 }, () => summary)] });
      case assets + 'gallery.vsix': {
        const response = new Response(bytes);
        Object.defineProperties(response, { url: { value: cdn + '/file.vsix' }, redirected: { value: true } });
        return response;
      }
      case assets + 'gallery.sha256': {
        const response = new Response(options.checksum ?? goodHash);
        Object.defineProperty(response, 'url', { value: url.href });
        return response;
      }
      case assets + 'gallery.sigzip': {
        const response = new Response(options.bundle ?? createZip([{ name: '.signature.sig', data: options.signature ?? signature }]));
        Object.defineProperty(response, 'url', { value: url.href });
        return response;
      }
      case keyPath:
        return new Response(options.key ?? publicKey);
      default:
        throw new Error('Unexpected fixture request ' + url.href);
    }
  });
  return { service: new ExtensionGalleryService(config, request), request };
}

it('drops invalid search rows, bounds the page, and requests only the encoded query and page', async () => {
  const { service, request } = fixture();
  const page = await service.search('a & #');
  expect(page.extensions).toHaveLength(18);
  expect(page.nextOffset).toBe(20);
  expect(page.extensions[0]).toMatchObject({ id: 'test.gallery', verifiedPublisher: true });
  const [url, init] = request.mock.calls[0];
  expect(String(url)).toBe(origin + '/api/-/search?query=a+%26+%23&size=20&offset=0');
  expect(init).toMatchObject({ credentials: 'omit', mode: 'cors', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(init?.headers).toBeUndefined();
});

it('verifies Ed25519 over the same bytes it returns, through the configured download hosts', async () => {
  const { service, request } = fixture();
  const downloaded = await service.download(await service.getExtension(id, '1.0.0'));
  expect(downloaded).toEqual({ bytes, sha256: goodHash, host: 'openvsx.eclipsecontent.org',
    signature: { state: 'verified', keyId: 'a-key' } });
  expect(request.mock.calls.map(([, init]) => init?.redirect)).toEqual(['error', 'follow', 'follow', 'follow', 'error']);
});

it('rejects a missing key or malformed bundle/key, including when Ed25519 is unavailable', async () => {
  const importKey = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new DOMException('Unsupported', 'NotSupportedError'));
  for (const [options, message] of [
    [{ key: 'invalid' }, /invalid public key/i],
    [{ bundle: createZip([{ name: '.signature.manifest', data: '{}' }]) }, /lacks a valid Ed25519/i],
  ] as const) {
    const { service } = fixture(options);
    await expect(service.download(await service.getExtension(id))).rejects.toThrow(message);
  }
  expect(importKey).not.toHaveBeenCalled();
  const { service } = fixture({ metadata: { files: {
    download: origin + assets + 'gallery.vsix', sha256: origin + assets + 'gallery.sha256',
    signature: origin + assets + 'gallery.sigzip',
  } } });
  await expect(service.getExtension(id)).rejects.toThrow(/incomplete or invalid signature metadata/i);
});

it('only accepts an unsigned or unsupported result once the checksum matches', async () => {
  const unsigned = fixture({ unsigned: true }).service;
  expect((await unsigned.download(await unsigned.getExtension(id))).signature).toEqual({ state: 'unsigned' });
  const importKey = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new DOMException('Unsupported', 'NotSupportedError'));
  const { service } = fixture();
  expect((await service.download(await service.getExtension(id))).signature).toEqual({ state: 'unverifiable', keyId: 'a-key' });
  importKey.mockClear();
  const bad = fixture({ checksum: '0'.repeat(64) }).service;
  await expect(bad.download(await bad.getExtension(id))).rejects.toThrow(/SHA-256 checksum does not match/i);
  expect(importKey).not.toHaveBeenCalled();
});

it('rejects a cryptographically incorrect signature and an ordinary import failure', async () => {
  const invalid = new Uint8Array(signature);
  invalid[0] ^= 1;
  const { service } = fixture({ signature: invalid });
  const release = await service.getExtension(id);
  await expect(service.download(release)).rejects.toThrow(/signature does not match/i);
  vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new DOMException('Invalid', 'DataError'));
  await expect(service.download(release)).rejects.toMatchObject({ name: 'DataError' });
});

it('rejects wrong identity, non-web metadata, and foreign download origins before requesting package bytes', async () => {
  const node = fixture({ web: false });
  await expect(node.service.download(await node.service.getExtension(id))).rejects.toThrow(/not a web extension/i);
  expect(node.request).toHaveBeenCalledTimes(1);
  const wrong = fixture({ metadata: { name: 'different' } });
  await expect(wrong.service.getExtension(id)).rejects.toThrow(/invalid extension metadata/i);
  const other = fixture({ metadata: { files: { download: 'https://other.example/package.vsix', sha256: origin + assets + 'gallery.sha256' } } });
  await expect(other.service.getExtension(id)).rejects.toThrow(/did not provide a package download/i);
  expect(other.request).toHaveBeenCalledTimes(1);
});

it('accepts assets the service host serves itself without listing it as a download host', async () => {
  const { request } = fixture({ unsigned: true });
  const direct = vi.fn<typeof fetch>(async (input, init) => {
    if (!String(input).endsWith('.vsix')) {
      return request(input, init);
    }
    const response = new Response(bytes);
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  });
  const service = new ExtensionGalleryService({ serviceUrl: origin, allowedDownloadHosts: [] }, direct);
  expect((await service.download(await service.getExtension(id))).host).toBe('open-vsx.org');
});

it('keeps a search row whose description spans lines', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ offset: 0, totalSize: 1, extensions: [
    { name: 'gallery', namespace: 'test', version: '1.0.0', description: 'first\r\n\tsecond' },
  ] }));
  const page = await new ExtensionGalleryService(config, request).search('gallery');
  expect(page.extensions.map(extension => extension.description)).toEqual(['first second']);
});

it.each([200, 429])('blocks further network requests after quota exhaustion (HTTP %s)', async status => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ offset: 0, totalSize: 0, extensions: [] },
    { status, headers: { 'X-RateLimit-Remaining': '0' } }));
  const service = new ExtensionGalleryService(config, request);
  if (status === 429) {
    await expect(service.search('first')).rejects.toBeInstanceOf(GalleryRateLimitError);
  } else {
    await service.search('first');
  }
  await expect(service.search('second')).rejects.toBeInstanceOf(GalleryRateLimitError);
  expect(request).toHaveBeenCalledTimes(1);
});

it('makes no request without gallery configuration', async () => {
  const request = vi.fn<typeof fetch>();
  const service = new ExtensionGalleryService(undefined, request);
  expect(service.enabled).toBe(false);
  await expect(service.search('offline')).rejects.toThrow(/unavailable/i);
  expect(request).not.toHaveBeenCalled();
});

it.skipIf(process.env.WRITING_ROOM_TEST_OPEN_VSX !== '1')('reads the fixed real Open VSX release metadata', async () => {
  const service = new ExtensionGalleryService(config);
  const release = await service.getExtension({ namespace: 'DavidAnson', name: 'vscode-markdownlint' }, '0.62.1');
  expect(release).toMatchObject({ id: 'davidanson.vscode-markdownlint', isWebExtension: true, signature: { keyId: expect.any(String) } });
});
