// @vitest-environment node
import { describe, expect, test } from 'vitest';
import { unixModes } from '../../../../base/test/common/zipTestUtils.js';
import { isPackagePath, readVsix, VsixError, vsixLimits, vsixManifestLimit } from '../../common/extensionManagementUtil.js';
import { createVsix, sampleManifest, vsixManifestXml } from './vsixTestUtils.js';

const decoder = new TextDecoder();

async function vsixError(bytes: Uint8Array): Promise<VsixError> {
  const error = await readVsix(bytes).then(() => { throw new Error('The package was accepted.'); }, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(VsixError);
  return error as VsixError;
}

describe('readVsix', () => {
  test('reads the manifest and lists only the files under extension/', async () => {
    const icon = Uint8Array.from({ length: 300 }, (_, index) => index & 0xff);
    const vsix = await readVsix(createVsix({
      manifest: { ...sampleManifest, publisher: 'Tester', name: 'Sample-Ext', icon: 'media/icon.png' },
      files: { 'dist/web.js': 'exports.activate = () => {};\n', 'media/icon.png': icon, '안내.md': '# 안내\n' },
    }));

    expect(vsix.manifest).toMatchObject({ publisher: 'Tester', name: 'Sample-Ext', version: '1.0.0', browser: './dist/web.js' });
    expect(vsix.identifier).toBe('tester.sample-ext');
    expect(vsix.targetPlatform).toBeUndefined();
    expect(vsix.files.map(file => file.path)).toEqual(['package.json', 'dist/web.js', 'media/icon.png', '안내.md']);
    expect(vsix.size).toBe(vsix.files.reduce((sum, file) => sum + file.size, 0));
    expect(vsix.files.find(file => file.path === 'media/icon.png')!.size).toBe(300);
    expect(vsix.warnings).toEqual([]);

    const read = (path: string) => vsix.read(vsix.files.find(file => file.path === path)!);
    expect(await read('media/icon.png')).toEqual(icon);
    expect(decoder.decode(await read('안내.md'))).toBe('# 안내\n');
    expect(JSON.parse(decoder.decode(await read('package.json')))).toEqual(vsix.manifest);
  });

  test('refuses a file that does not belong to the package', async () => {
    const vsix = await readVsix(createVsix());
    await expect(vsix.read({ path: 'dist/web.js', size: 1 })).rejects.toThrow(VsixError);
  });

  test.each(['universal', 'web'])('accepts the %s platform', async platform => {
    expect((await readVsix(createVsix({ targetPlatform: platform }))).targetPlatform).toBe(platform);
  });

  test.each(['linux-x64', 'win32-x64', 'darwin-arm64', 'alpine-x64'])('refuses the platform-specific package for %s', async platform => {
    const error = await vsixError(createVsix({ targetPlatform: platform }));
    expect(error.entry).toBe('extension.vsixmanifest');
    expect(error.message).toContain(`platform-specific package for "${platform}"`);
  });

  test('finds TargetPlatform in single quotes and ignores commented-out Identity elements', async () => {
    const xml = vsixManifestXml().replace('<Metadata>', '<Metadata><!-- <Identity TargetPlatform="web"/> -->')
      .replace('Publisher="tester"', "Publisher=\"tester\" TargetPlatform = 'linux-x64'");
    expect((await vsixError(createVsix({ vsixManifest: xml }))).message).toContain('"linux-x64"');
  });

  test('accepts a package without extension.vsixmanifest', async () => {
    expect((await readVsix(createVsix({ vsixManifest: null }))).targetPlatform).toBeUndefined();
  });

  test('refuses an extension.vsixmanifest larger than the limit', async () => {
    const xml = vsixManifestXml() + ' '.repeat(vsixManifestLimit);
    expect((await vsixError(createVsix({ vsixManifest: xml }))).entry).toBe('extension.vsixmanifest');
  });

  test('refuses a package without extension/package.json', async () => {
    const error = await vsixError(createVsix({ manifest: null, entries: [{ name: 'package.json', data: JSON.stringify(sampleManifest) }] }));
    expect(error.entry).toBe('extension/package.json');
    expect(error.message).toContain('no extension/package.json');
  });

  test('refuses a package.json larger than 256 KiB and accepts one at the limit', async () => {
    const text = JSON.stringify(sampleManifest);
    const padded = (length: number) => text + ' '.repeat(length - text.length);
    expect((await readVsix(createVsix({ manifest: padded(vsixManifestLimit) }))).manifest.name).toBe('sample');

    const error = await vsixError(createVsix({ manifest: padded(vsixManifestLimit + 1) }));
    expect(error.entry).toBe('extension/package.json');
    expect(error.message).toContain(`${vsixManifestLimit + 1} bytes, more than the limit of ${vsixManifestLimit}`);
  });

  test.each([
    ['not JSON', '{ "name": ', 'not valid JSON'],
    ['not UTF-8', new Uint8Array([0x7b, 0xff, 0x7d]), 'not valid UTF-8'],
    ['without a version', { name: 'sample', publisher: 'tester' }, 'version: Expected a valid extension version.'],
    ['with a browser path outside the package', { ...sampleManifest, browser: '../outside.js' }, 'browser: Expected a path inside'],
    ['with an icon URL', { ...sampleManifest, icon: 'https://example.com/icon.png' }, 'icon: Expected a path inside'],
  ])('refuses a package.json %s', async (_, manifest, reason) => {
    const bytes = manifest instanceof Uint8Array
      ? createVsix({ manifest: null, entries: [{ name: 'extension/package.json', data: manifest }] })
      : createVsix({ manifest });
    const error = await vsixError(bytes);
    expect(error.entry).toBe('extension/package.json');
    expect(error.message).toContain(reason);
  });

  test('reports ZIP problems as VsixError naming the entry', async () => {
    const error = await vsixError(createVsix({ entries: [{ name: 'extension/../../x', data: 'x' }] }));
    expect(error.entry).toBe('extension/../../x');
    expect(error.message).toContain('"extension/../../x"');
  });

  test('wraps errors of later reads in VsixError', async () => {
    const vsix = await readVsix(createVsix({ entries: [{ name: 'extension/bad.js', data: 'abc', crc: 0 }] }));
    const error = await vsix.read(vsix.files.find(file => file.path === 'bad.js')!).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VsixError);
    expect((error as VsixError).entry).toBe('extension/bad.js');
  });

  test('passes symbolic links on as warnings', async () => {
    const vsix = await readVsix(createVsix({ entries: [{ name: 'extension/link', data: '/etc/passwd', unixMode: unixModes.symbolicLink }] }));
    expect(vsix.files.map(file => file.path)).not.toContain('link');
    expect(vsix.warnings).toEqual(['Skipped symbolic link "extension/link".']);
  });

  test('refuses a package larger than the download limit', async () => {
    const error = await vsixError(new Uint8Array(vsixLimits.download + 1));
    expect(error.message).toContain(`more than the limit of ${50 * 1024 * 1024} bytes`);
  });

  test('stops with the reason of an aborted signal', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(readVsix(createVsix(), controller.signal)).rejects.toBe(reason);
  });
});

describe('isPackagePath', () => {
  test.each(['dist/web.js', './dist/web.js', 'media//icon.png', 'a/../b.js', '한글/파일.js'])('accepts %j', path => {
    expect(isPackagePath(path)).toBe(true);
  });

  test.each([
    '', '.', './', '/abs.js', '../x.js', 'a/../../x.js', 'a\\b.js', 'C:x.js', 'https://host/x.js', 'file:x.js',
    'x.js?query', 'x.js#hash', 'a\u0000b', 'a\u007fb', undefined, 42,
  ])('refuses %j', path => {
    expect(isPackagePath(path)).toBe(false);
  });
});

test('keeps the ZIP limits of the master plan', () => {
  expect(vsixLimits).toEqual({
    download: 50 * 1024 * 1024,
    maxEntries: 10_000,
    maxTotalSize: 200 * 1024 * 1024,
    maxEntrySize: 64 * 1024 * 1024,
    maxPathBytes: 512,
  });
});
