import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { sha256 } from '../../scripts/lib/real-extensions.mjs';

export interface ZipEntry {
  readonly name: string;
  readonly content?: string | Uint8Array;
  // Unix file mode for the external attributes, e.g. 0o120777 for a symbolic link.
  readonly mode?: number;
}

// Writes a ZIP archive (deflated entries, made on Unix) so tests can hand crafted packages to the readers.
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content ?? '');
    const compressed = deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

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
    { name: 'extension/package.json', content: JSON.stringify({ publisher: 'test', name: 'fake', version: '1.0.0', browser: './extension.js' }) },
    { name: 'extension/extension.js', content: 'exports.activate = () => {};\n' },
  ]);
  const keys = generateKeyPairSync('ed25519');
  const sigzip = createZip([{ name: '.signature.sig', content: sign(null, vsix, keys.privateKey) }]);
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
