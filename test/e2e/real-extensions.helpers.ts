import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPins, sha256 } from '../../scripts/lib/real-extensions.mjs';
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

const registry = 'https://open-vsx.org';
const cdn = 'https://openvsx.eclipsecontent.org';

/**
 * Answers the product's Open VSX requests from the fixture gallery (test/fixtures/routes/openvsx.mjs, the pinned and
 * signed cache). The fixture names its own origin in the URLs it returns; they are put back on open-vsx.org, so the
 * product's default gallery and its host checks are the ones in use. The redirect to the second host is followed
 * here: browser routing intercepts only the first hop.
 */
async function answerFromFixtureGallery(route: Route): Promise<void> {
  const fixtureService = openVsxServiceUrl();
  const fixtureContent = 'http://localhost:' + process.env.E2E_EXTENSIONS_PORT + '/openvsx-content';
  const url = new URL(route.request().url());
  const target = url.origin === cdn ? fixtureContent + url.pathname.replace(/^\/openvsx-content/, '') : fixtureService + url.pathname;
  const response = await route.fetch({ url: target + url.search, maxRedirects: 0 });
  const location = response.headers()['location'];
  if (response.status() === 302 && location) {
    await route.fulfill({ response: await route.fetch({ url: location }) });
  } else if ((response.headers()['content-type'] ?? '').startsWith('application/json')) {
    await route.fulfill({ response, body: (await response.text()).replaceAll(fixtureService, registry) });
  } else {
    await route.fulfill({ response });
  }
}

/** Routes the default gallery (open-vsx.org and its download host) to the fixture gallery for this page. */
export async function routeFixtureGallery(page: Page): Promise<void> {
  await page.route(url => url.origin === registry || url.origin === cdn, answerFromFixtureGallery);
}

/** The pin of `id` in pins.json, which must be there. */
export async function realPin(id: string): Promise<{ id: string; version: string; publicKey: string; vsix: { sha256: string } }> {
  const pin = (await readPins()).extensions.find((entry: { id: string }) => entry.id === id);
  if (!pin) {
    throw new Error(`pins.json has no ${id} release.`);
  }
  return pin;
}

export const gallerySearch = (page: Page): Locator => page.getByRole('searchbox', { name: 'Search Open VSX' });
export const galleryResults = (page: Page): Locator => page.getByRole('list', { name: 'Open VSX search results' });
export const installedExtensions = (page: Page): Locator => page.getByRole('list', { name: 'Installed extensions' });
export const uninstallButton = (page: Page, name: RegExp): Locator => installedExtensions(page).getByRole('button', { name });

export async function openExtensions(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Shift+x');
  await expect(gallerySearch(page)).toBeFocused();
}

/**
 * The package is downloaded and its signature checked before the confirmation shows, and unpacked into storage after it
 * is accepted: seconds for a large one (vscode.markdown-language-features is 4 MB) on a busy machine.
 */
const installTimeout = 20_000;

/** Searches the gallery, installs the row that has `rowText`, and returns the confirmation's text before accepting it. */
export async function installFromGallery(page: Page, query: string, rowText: string, installedName: RegExp): Promise<string> {
  await openExtensions(page);
  await gallerySearch(page).fill(query);
  await galleryResults(page).getByRole('listitem').filter({ hasText: rowText }).getByRole('button', { name: /^Install / }).click();
  const confirmation = page.getByRole('option', { name: /^Install / });
  await expect(confirmation).toBeVisible({ timeout: installTimeout });
  const text = await confirmation.innerText();
  await confirmation.click();
  await expect(uninstallButton(page, installedName)).toBeVisible({ timeout: installTimeout });
  return text;
}
