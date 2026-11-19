// The real-extension cache tooling, run in Node without a browser: integrity of the cache, the VSIX reader and the
// path containment the fixture routes use. None of it needs the real cache or the network.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { extractVsix, readZip, repositoryRoot, resolveContained } from '../../scripts/lib/real-extensions.mjs';
import { createFakeCache, createZip } from './real-extensions.helpers.js';
import type { FakeCache } from './real-extensions.helpers.js';

const run = promisify(execFile);

async function script(name: string, fake: FakeCache, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [join(repositoryRoot, 'scripts', name), '--pins', fake.pins, '--cache', fake.cache, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

test.describe('real extension cache', () => {
  let fake: FakeCache;
  test.beforeEach(async () => {
    fake = await createFakeCache();
  });
  test.afterEach(async () => {
    await rm(fake.root, { recursive: true, force: true });
  });

  test('accepts a cache that matches its pins and its signature', async () => {
    const result = await script('fetch-real-extensions.mjs', fake, '--offline');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ok test.fake@1.0.0 cached (sha256 and signature verified)');
  });

  test('fails on a VSIX with one changed byte, and the probe does not unpack it', async () => {
    const bytes = await readFile(fake.vsix);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(fake.vsix, bytes);
    const fetched = await script('fetch-real-extensions.mjs', fake, '--offline');
    expect(fetched.code).toBe(1);
    expect(fetched.stderr).toContain('test.fake-1.0.0.vsix: sha256');
    expect(fetched.stderr).toContain('does not match the pinned');
    const probed = await script('probe-extension.mjs', fake);
    expect(probed.code).toBe(1);
    expect(probed.stderr).toContain('test.fake-1.0.0.vsix: sha256');
    expect(existsSync(join(fake.cache, 'unpacked'))).toBe(false);
  });

  test('fails when the signature does not belong to the package', async () => {
    const other = await createFakeCache();
    try {
      // A valid signature archive from another key, pinned so that only the signature check can catch it.
      const pins = JSON.parse(await readFile(fake.pins, 'utf8'));
      const otherPins = JSON.parse(await readFile(other.pins, 'utf8'));
      pins.extensions[0].signature = otherPins.extensions[0].signature;
      await writeFile(fake.pins, JSON.stringify(pins));
      await writeFile(join(fake.cache, 'test.fake-1.0.0.sigzip'), await readFile(join(other.cache, 'test.fake-1.0.0.sigzip')));
      const result = await script('fetch-real-extensions.mjs', fake, '--offline');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('signature');
      expect(result.stderr).toContain('does not verify');
    } finally {
      await rm(other.root, { recursive: true, force: true });
    }
  });

  test('reports a missing cache offline instead of passing', async () => {
    await rm(fake.vsix);
    const result = await script('fetch-real-extensions.mjs', fake, '--offline');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not in the cache');
  });
});

test('serves only files inside the folder', () => {
  const root = join(repositoryRoot, 'test/fixtures/real-extensions/cache/unpacked');
  expect(resolveContained(root, '/test.fake-1.0.0/package.json')).toBe(join(root, 'test.fake-1.0.0/package.json'));
  for (const path of [
    '/../pins.json', '/a/../../pins.json', '/%2e%2e/pins.json', '/a%2f..%2f..%2fpins.json', '/a%5c..%5cpins.json',
    '/a/./b', '//etc/passwd', '/a%00b', '/', '', '/a/%E0%A4%A', '/a?b',
  ]) {
    expect(resolveContained(root, path), path).toBeUndefined();
  }
});

test.describe('VSIX reader', () => {
  for (const [what, entries] of [
    ['a path escape', [{ name: 'extension/../../evil.js' }]],
    ['an absolute path', [{ name: '/extension/evil.js' }]],
    ['a backslash path', [{ name: 'extension\\..\\evil.js' }]],
    ['a duplicate name', [{ name: 'extension/a.js' }, { name: 'extension/A.js' }]],
    ['a symbolic link', [{ name: 'extension/link', content: '/etc/passwd', mode: 0o120777 }]],
  ] as const) {
    test(`refuses ${what}`, () => {
      expect(() => readZip(createZip([{ name: 'extension/package.json', content: '{}' }, ...entries]))).toThrow();
    });
  }

  test('refuses an entry that inflates past its declared size', () => {
    const zip = createZip([{ name: 'extension/package.json', content: 'x'.repeat(1000) }]);
    // Declare 10 bytes in the central directory; the reader must not inflate more than that.
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, central + 24);
    expect(() => readZip(zip).read('extension/package.json')).toThrow();
  });

  test('unpacks the extension folder only', async () => {
    const fake = await createFakeCache();
    try {
      const destination = join(fake.root, 'unpacked');
      await extractVsix(createZip([
        { name: 'extension.vsixmanifest', content: '<x/>' },
        { name: 'extension/package.json', content: '{"name":"fake"}' },
        { name: 'extension/dist/extension.js', content: 'exports.x = 1;' },
      ]), destination);
      expect(await readFile(join(destination, 'package.json'), 'utf8')).toBe('{"name":"fake"}');
      expect(await readFile(join(destination, 'dist/extension.js'), 'utf8')).toBe('exports.x = 1;');
      expect(existsSync(join(destination, 'extension.vsixmanifest'))).toBe(false);
    } finally {
      await rm(fake.root, { recursive: true, force: true });
    }
  });
});
