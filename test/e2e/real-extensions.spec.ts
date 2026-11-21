// The real-extension cache tooling, run in Node without a browser: integrity of the cache, the VSIX reader and the
// path containment, the Open VSX fixture route and the missing-cache rule. Only the route tests that serve real
// packages need the cache (they skip without it); none of it uses the network.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import {
  defaultCacheDir, extractVsix, readPins, readZip, repositoryRoot, resolveContained, sha256, verifyPackageSignature,
  writeVerified,
} from '../../scripts/lib/real-extensions.mjs';
import { createZip, unixModes } from '../../src/base/test/common/zipTestUtils.js';
import { createFakeCache, openVsxServiceUrl, requireRealExtensions } from './real-extensions.helpers.js';
import type { FakeCache } from './real-extensions.helpers.js';

const run = promisify(execFile);

async function script(name: string, fake: FakeCache, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  // Exercise NO_COLOR in every run. Playwright's FORCE_COLOR would make Node warn on stderr.
  env.NO_COLOR = '1';
  delete env.FORCE_COLOR;
  try {
    const { stdout, stderr } = await run(
      process.execPath, [join(repositoryRoot, 'scripts', name), '--pins', fake.pins, '--cache', fake.cache, ...args], { env },
    );
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

  test('writes over a temporary file a dead run of the same process id left behind', async () => {
    const path = join(fake.cache, 'written.bin');
    const bytes = Buffer.from('verified');
    await writeFile(`${path}.tmp-${process.pid}`, 'left behind');
    await writeVerified({ path, url: 'https://open-vsx.org/x', sha256: sha256(bytes), limit: 1024 }, bytes);
    expect(await readFile(path, 'utf8')).toBe('verified');
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
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
    ['a symbolic link', [{ name: 'extension/link', data: '/etc/passwd', unixMode: unixModes.symbolicLink }]],
  ] as const) {
    test(`refuses ${what}`, () => {
      expect(() => readZip(createZip([{ name: 'extension/package.json', data: '{}' }, ...entries]))).toThrow();
    });
  }

  test('refuses an entry that inflates past its declared size', () => {
    // Declares 10 bytes for 1000; the reader must not inflate more than that.
    const zip = createZip([{ name: 'extension/package.json', data: 'x'.repeat(1000), size: 10 }]);
    expect(() => readZip(zip).read('extension/package.json')).toThrow();
  });

  test('unpacks the extension folder only', async () => {
    const fake = await createFakeCache();
    try {
      const destination = join(fake.root, 'unpacked');
      await extractVsix(createZip([
        { name: 'extension.vsixmanifest', data: '<x/>' },
        { name: 'extension/package.json', data: '{"name":"fake"}' },
        { name: 'extension/dist/extension.js', data: 'exports.x = 1;' },
      ]), destination);
      expect(await readFile(join(destination, 'package.json'), 'utf8')).toBe('{"name":"fake"}');
      expect(await readFile(join(destination, 'dist/extension.js'), 'utf8')).toBe('exports.x = 1;');
      expect(existsSync(join(destination, 'extension.vsixmanifest'))).toBe(false);
    } finally {
      await rm(fake.root, { recursive: true, force: true });
    }
  });
});

async function startFixtureServer(cache: string): Promise<{ origin: string; stop: () => void }> {
  const server = spawn(process.execPath, [join(repositoryRoot, 'test/fixtures/serve-extensions.mjs'), '0'], {
    env: { ...process.env, E2E_REAL_EXTENSIONS_CACHE: cache }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<string>((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = /listening on (\d+)/.exec(output);
      if (match) {
        resolve(match[1]);
      }
    });
    server.once('exit', code => reject(new Error('fixture server exited with ' + code)));
  });
  return { origin: 'http://127.0.0.1:' + port, stop: () => server.kill() };
}

test.describe('Open VSX fixture route', () => {
  test('serves the cached packages in the Open VSX shape, with the file redirect to a second host', async () => {
    requireRealExtensions();
    const service = openVsxServiceUrl();
    const search = await (await fetch(service + '/api/-/search?query=markdownlint&size=5')).json();
    expect(search).toMatchObject({ offset: 0, totalSize: 1, extensions: [{ namespace: 'DavidAnson', name: 'vscode-markdownlint', version: '0.62.1' }] });

    const pins = await readPins();
    for (const pin of pins.extensions) {
      const metadata = await (await fetch(`${service}/api/${pin.namespace}/${pin.name}/${pin.version}`)).json();
      expect(metadata).toMatchObject({ namespace: pin.namespace, name: pin.name, version: pin.version, downloadSizes: { universal: pin.vsix.size } });
      expect(metadata.extensionKind).toContain('web');
      const redirect = await fetch(metadata.files.download, { redirect: 'manual' });
      expect(redirect.status).toBe(302);
      const location = new URL(redirect.headers.get('location')!);
      expect(location.hostname).toBe('localhost');
      const vsix = new Uint8Array(await (await fetch(location)).arrayBuffer());
      expect(sha256(vsix)).toBe(pin.vsix.sha256);
      expect((await (await fetch(metadata.files.sha256)).text()).trim()).toBe(pin.vsix.sha256);
      const signature = new Uint8Array(await (await fetch(metadata.files.signature)).arrayBuffer());
      const key = await (await fetch(metadata.files.publicKey)).text();
      expect(verifyPackageSignature(vsix, signature, key)).toBe(true);
    }
    const markdownlint = await (await fetch(service + '/api/DavidAnson/vscode-markdownlint')).json();
    expect((await fetch(markdownlint.files.icon)).headers.get('content-type')).toBe('image/png');
    expect(await (await fetch(markdownlint.files.manifest)).json()).toMatchObject({ name: 'vscode-markdownlint', version: '0.62.1' });
  });

  test('serves nothing outside the cache', async () => {
    const origin = new URL(openVsxServiceUrl()).origin;
    for (const path of [
      '/openvsx-content/vscode/markdown/1.95.3/../../../../real-extensions/pins.json',
      '/openvsx-content/vscode/markdown/1.95.3/%2e%2e%2f%2e%2e%2fpins.json',
      '/openvsx-content/vscode/markdown/1.95.3/..%5c..%5cpins.json',
      '/openvsx-content/vscode/markdown/1.95.3/extension.js',
      '/openvsx/api/vscode/markdown/1.95.3/file/..%2fpins.json',
    ]) {
      const response = await fetch(origin + path, { redirect: 'manual' });
      expect(response.status, path).toBe(404);
    }
  });

  test('refuses to serve a package whose cached bytes changed, and answers 404 without a cache', async () => {
    requireRealExtensions();
    // The cache playwright.config.ts checked, which E2E_REAL_EXTENSIONS_CACHE may point elsewhere.
    const cacheDir = process.env.E2E_REAL_EXTENSIONS_CACHE || defaultCacheDir;
    const copy = await mkdtemp(join(tmpdir(), 'writing-room-openvsx-'));
    const empty = await mkdtemp(join(tmpdir(), 'writing-room-openvsx-empty-'));
    let changed: Awaited<ReturnType<typeof startFixtureServer>> | undefined;
    let missing: Awaited<ReturnType<typeof startFixtureServer>> | undefined;
    try {
      changed = await startFixtureServer(copy);
      missing = await startFixtureServer(empty);
      // Leaves out the probe's folders by their place in the cache, not by a match anywhere in the absolute path.
      await cp(cacheDir, copy, { recursive: true, filter: source => !['unpacked', 'probe-results'].includes(relative(cacheDir, source).split(sep)[0]) });
      const vsix = join(copy, 'vscode.markdown-1.95.3.vsix');
      const bytes = await readFile(vsix);
      bytes[100] ^= 1;
      await writeFile(vsix, bytes);
      const file = '/openvsx-content/vscode/markdown/1.95.3/vscode.markdown-1.95.3.vsix';
      const refused = await fetch(changed.origin + file);
      expect(refused.status).toBe(500);
      expect(await refused.text()).toContain('does not match the pinned');
      expect((await fetch(changed.origin + '/openvsx/api/vscode/markdown/1.95.3')).status).toBe(500);
      expect((await fetch(changed.origin + '/openvsx/api/DavidAnson/vscode-markdownlint/0.62.1')).status).toBe(200);
      // The key is shared with the changed package and checked on its own.
      const key = '/openvsx/api/-/public-key/' + Object.keys((await readPins()).publicKeys)[0];
      expect((await fetch(changed.origin + key)).status).toBe(200);
      expect((await fetch(missing.origin + file)).status).toBe(404);
      expect((await fetch(missing.origin + key)).status).toBe(404);
      expect(await (await fetch(missing.origin + '/openvsx/api/-/search?query=')).json()).toEqual({ offset: 0, totalSize: 0, extensions: [] });
    } finally {
      changed?.stop();
      missing?.stop();
      await rm(copy, { recursive: true, force: true });
      await rm(empty, { recursive: true, force: true });
    }
  });
});

test.describe('missing real extension cache', () => {
  async function list(environment: Record<string, string>): Promise<{ code: number; output: string }> {
    const empty = await mkdtemp(join(tmpdir(), 'writing-room-no-cache-'));
    // A fresh config check: the runner's own result and requirement are not passed on.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.E2E_REAL_EXTENSIONS;
    delete env.E2E_REQUIRE_REAL_EXTENSIONS;
    Object.assign(env, { E2E_REAL_EXTENSIONS_CACHE: empty }, environment);
    try {
      const { stdout, stderr } = await run(process.execPath, [join(repositoryRoot, 'node_modules/@playwright/test/cli.js'), 'test', '--list', 'test/e2e/smoke.spec.ts'], { cwd: repositoryRoot, env });
      return { code: 0, output: stdout + stderr };
    } catch (error) {
      const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
      return { code, output: stdout + stderr };
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  }

  test('prints why the real extension tests are skipped', async () => {
    const result = await list({});
    expect(result.code).toBe(0);
    expect(result.output).toContain('The real extension cache is not usable, so the tests that install real extensions are skipped.');
    expect(result.output).toContain('is not in the cache');
  });

  test('fails the run with E2E_REQUIRE_REAL_EXTENSIONS=1', async () => {
    const result = await list({ E2E_REQUIRE_REAL_EXTENSIONS: '1' });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('cannot run (E2E_REQUIRE_REAL_EXTENSIONS=1)');
  });

  test('fails the run with E2E_REQUIRE_REAL_EXTENSIONS=1 when E2E_REAL_EXTENSIONS was set before the run', async () => {
    const result = await list({ E2E_REAL_EXTENSIONS: 'missing', E2E_REQUIRE_REAL_EXTENSIONS: '1' });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('cannot run (E2E_REQUIRE_REAL_EXTENSIONS=1)');
  });
});
