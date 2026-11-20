import { test } from '@playwright/test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../scripts/lib/real-extensions.mjs';
import { createZip } from '../../src/base/test/common/zipTestUtils.js';

export interface FakeCache {
  readonly root: string;
  readonly pins: string;
  readonly cache: string;
  readonly vsix: string;
}

// A pins file and a filled cache for one made-up extension, signed with a fresh Ed25519 key. The URLs are never
// requested: the tests run the scripts against this cache offline.
export async function createFakeCache(): Promise<FakeCache> {
  const root = await mkdtemp(join(tmpdir(), 'writing-room-real-extensions-'));
  const cache = join(root, 'cache');
  await mkdir(cache);
  const vsix = createZip([
    { name: 'extension/package.json', data: JSON.stringify({ publisher: 'test', name: 'fake', version: '1.0.0', browser: './extension.js' }) },
    { name: 'extension/extension.js', data: 'exports.activate = () => {};\n' },
  ]);
  const keys = generateKeyPairSync('ed25519');
  const sigzip = createZip([{ name: '.signature.sig', data: sign(null, vsix, keys.privateKey) }]);
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const base = 'https://open-vsx.org/api/test/fake/1.0.0/file/test.fake-1.0.0';
  const pins = {
    publicKeys: { 'test-key': { url: 'https://open-vsx.org/api/-/public-key/test-key', sha256: sha256(Buffer.from(publicKey)), size: publicKey.length } },
    extensions: [{
      id: 'test.fake', namespace: 'test', name: 'fake', version: '1.0.0',
      vsix: { url: base + '.vsix', sha256: sha256(vsix), size: vsix.length },
      sha256File: { url: base + '.sha256' },
      signature: { url: base + '.sigzip', sha256: sha256(sigzip), size: sigzip.length },
      publicKey: 'test-key',
    }],
  };
  await writeFile(join(root, 'pins.json'), JSON.stringify(pins));
  await writeFile(join(cache, 'test.fake-1.0.0.vsix'), vsix);
  await writeFile(join(cache, 'test.fake-1.0.0.sha256'), sha256(vsix));
  await writeFile(join(cache, 'test.fake-1.0.0.sigzip'), sigzip);
  await writeFile(join(cache, 'public-key-test-key.pem'), publicKey);
  return { root, pins: join(root, 'pins.json'), cache, vsix: join(cache, 'test.fake-1.0.0.vsix') };
}

// The gallery path of the Open VSX fixture (test/fixtures/routes/openvsx.mjs) on the extension fixture server.
export function openVsxServiceUrl(): string {
  return `http://127.0.0.1:${process.env.E2E_EXTENSIONS_PORT}/openvsx`;
}

// For specs that install the pinned real extensions: skips when playwright.config.ts found the cache unusable. The
// config already printed why, and fails the run instead when E2E_REQUIRE_REAL_EXTENSIONS=1.
export function requireRealExtensions(): void {
  test.skip(process.env.E2E_REAL_EXTENSIONS !== 'available',
    'The real extension cache is not usable. Run node scripts/fetch-real-extensions.mjs.');
}
