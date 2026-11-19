// @vitest-environment node
import { deflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { crc32, defaultZipLimits, inflateRaw, ZipArchive, ZipError, type ZipLimits } from '../../common/zip.js';
import { createZip, cutBytes, findEndOfCentralDirectory, unixModes, type ZipTestEntry } from './zipTestUtils.js';

const MiB = 1024 * 1024;
const encoder = new TextEncoder();

function openError(zip: Uint8Array, limits?: ZipLimits): ZipError {
  try {
    ZipArchive.open(zip, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(ZipError);
    return error as ZipError;
  }
  throw new Error('The archive was accepted.');
}

async function readError(archive: ZipArchive, path: string, signal?: AbortSignal): Promise<unknown> {
  const entry = archive.entries.find(candidate => candidate.path === path)!;
  return archive.read(entry, signal).then(() => { throw new Error('The entry was read.'); }, (error: unknown) => error);
}

function entry(archive: ZipArchive, path: string) {
  const found = archive.entries.find(candidate => candidate.path === path);
  expect(found).toBeDefined();
  return found!;
}

describe('reading entries', () => {
  test('returns the original bytes of stored, deflated and Korean-named entries', async () => {
    const binary = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 7919) & 0xff);
    const text = 'export function activate() {}\n'.repeat(500);
    const zip = createZip([
      { name: 'stored.bin', data: binary, method: 'store' },
      { name: 'deflated.js', data: text },
      { name: '확장/한글 이름.txt', data: '안녕하세요', method: 'store' },
      { name: '문서.md', data: '# 제목\n', flags: 0 },
      { name: 'empty.txt' },
    ]);
    const archive = ZipArchive.open(zip);

    expect(archive.entries.map(({ path, size }) => ({ path, size }))).toEqual([
      { path: 'stored.bin', size: binary.length },
      { path: 'deflated.js', size: text.length },
      { path: '확장/한글 이름.txt', size: encoder.encode('안녕하세요').length },
      { path: '문서.md', size: encoder.encode('# 제목\n').length },
      { path: 'empty.txt', size: 0 },
    ]);
    expect(entry(archive, 'deflated.js').compressedSize).toBeLessThan(text.length);
    expect(await archive.read(entry(archive, 'stored.bin'))).toEqual(binary);
    expect(await archive.read(entry(archive, 'deflated.js'))).toEqual(encoder.encode(text));
    expect(await archive.read(entry(archive, '확장/한글 이름.txt'))).toEqual(encoder.encode('안녕하세요'));
    expect(await archive.read(entry(archive, '문서.md'))).toEqual(encoder.encode('# 제목\n'));
    expect(await archive.read(entry(archive, 'empty.txt'))).toEqual(new Uint8Array(0));
    expect(archive.warnings).toEqual([]);
  });

  test('a stored read returns a copy, not a view of the archive', async () => {
    const zip = createZip([{ name: 'a.txt', data: 'abc', method: 'store' }]);
    const archive = ZipArchive.open(zip);
    const first = await archive.read(archive.entries[0]);
    first.fill(0);
    expect(await archive.read(archive.entries[0])).toEqual(encoder.encode('abc'));
  });

  test('ignores folder records, normalizes paths and keeps folders out of the entries', () => {
    const zip = createZip([
      { name: 'extension/', method: 'store' },
      { name: 'extension/./dist//web.js', data: 'x' },
      { name: './extension/package.json', data: '{}' },
    ]);
    expect(ZipArchive.open(zip).entries.map(found => found.path)).toEqual(['extension/dist/web.js', 'extension/package.json']);
  });

  test('accepts an archive comment of the largest size', () => {
    expect(ZipArchive.open(createZip([{ name: 'a', data: 'a' }], { comment: 0xffff })).entries).toHaveLength(1);
  });

  test('refuses an entry of another archive', async () => {
    const one = ZipArchive.open(createZip([{ name: 'a', data: 'a' }]));
    const two = ZipArchive.open(createZip([{ name: 'a', data: 'a' }]));
    await expect(two.read(one.entries[0])).rejects.toThrow(ZipError);
  });

  test('stops with the reason of an aborted signal', async () => {
    const archive = ZipArchive.open(createZip([{ name: 'a.txt', data: 'a'.repeat(100_000) }]));
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    expect(await readError(archive, 'a.txt', controller.signal)).toBe(reason);
  });
});

describe('entry names', () => {
  test.each([
    ['../x', 'leave the archive folder'],
    ['extension/../../x', 'leave the archive folder'],
    ['a/..', 'leave the archive folder'],
    ['/abs', 'absolute path'],
    ['C:\\x', 'backslash'],
    ['C:/x', 'drive letter'],
    ['extension\\..\\x', 'backslash'],
    ['a\u0000b', 'control character'],
    ['a\u001fb', 'control character'],
    ['a\u007fb', 'control character'],
    ['a\u0085b', 'control character'],
    ['.', 'no file name'],
  ])('refuses %j', (name, reason) => {
    const error = openError(createZip([{ name: 'ok.txt', data: 'ok' }, { name, data: 'x' }]));
    expect(error.entry).toBe(name);
    expect(error.message).toContain(JSON.stringify(name));
    expect(error.message).toContain(reason);
  });

  test('checks folder names as well', () => {
    expect(openError(createZip([{ name: '../folder/', method: 'store' }])).entry).toBe('../folder/');
  });

  test('counts the UTF-8 bytes of a name against the 512-byte limit', () => {
    const longest = '가'.repeat(170) + 'ab';
    expect(encoder.encode(longest)).toHaveLength(512);
    expect(ZipArchive.open(createZip([{ name: longest, data: 'x' }])).entries[0].path).toBe(longest);

    const tooLong = '가'.repeat(171);
    expect(encoder.encode(tooLong)).toHaveLength(513);
    const error = openError(createZip([{ name: tooLong, data: 'x' }]));
    expect(error.entry).toBe(tooLong);
    expect(error.message).toContain('513-byte name');
  });

  test('refuses a name that is not valid UTF-8, with or without the UTF-8 flag', () => {
    for (const flags of [0, 1 << 11]) {
      const error = openError(createZip([{ name: Uint8Array.of(0x61, 0xff, 0x62), data: 'x', flags }]));
      expect(error.message).toContain('not valid UTF-8');
    }
  });

  test.each([
    [['a/b', 'a/b']],
    [['a//b', 'a/b']],
    [['a/./b', 'a/b']],
    [['./a', 'a']],
    [['dir/file', 'dir//./file']],
  ])('refuses two entries with the same normalized path: %j', names => {
    const error = openError(createZip(names.map(name => ({ name, data: name }))));
    expect(error.entry).toBe(names[1]);
    expect(error.message).toContain('same path');
  });

  test.each([
    [['a', 'a/b']],
    [['a/b', 'a']],
    [['x/a/b/c', 'x/a']],
  ])('refuses a file whose path is also a folder: %j', names => {
    expect(openError(createZip(names.map(name => ({ name, data: name })))).message).toContain('as a folder');
  });

  test('refuses a file that has the path of a folder record', () => {
    expect(openError(createZip([{ name: 'a/', method: 'store' }, { name: 'a', data: 'x' }])).message).toContain('as a folder');
  });

  test('skips symbolic links with a warning and keeps files that carry a Unix mode', async () => {
    const archive = ZipArchive.open(createZip([
      { name: 'link', data: '/etc/passwd', method: 'store', unixMode: unixModes.symbolicLink },
      { name: 'file.txt', data: 'text', unixMode: unixModes.file },
    ]));
    expect(archive.entries.map(found => found.path)).toEqual(['file.txt']);
    expect(archive.warnings).toEqual(['Skipped symbolic link "link".']);
    expect(await archive.read(archive.entries[0])).toEqual(encoder.encode('text'));
  });
});

describe('limits', () => {
  const many = (count: number): ZipTestEntry[] => Array.from({ length: count }, (_, index) => ({ name: `f${index}`, method: 'store' }));

  test('accepts 10,000 records and refuses 10,001, folder records included', () => {
    expect(ZipArchive.open(createZip(many(10_000))).entries).toHaveLength(10_000);
    expect(openError(createZip(many(10_001))).message).toContain('10001 entries, more than the limit of 10000');
    expect(openError(createZip([...many(10_000), { name: 'folder/', method: 'store' }])).message).toContain('10001 entries');
  });

  test('refuses declared sizes past the default limits for one file and for the whole archive', () => {
    const declared = (name: string, size: number): ZipTestEntry => ({ name, data: 'x', size });
    expect(ZipArchive.open(createZip([declared('a', 64 * MiB)])).entries[0].size).toBe(64 * MiB);
    const tooLarge = openError(createZip([declared('a', 64 * MiB + 1)]));
    expect(tooLarge.entry).toBe('a');
    expect(tooLarge.message).toContain(`more than the limit of ${64 * MiB} bytes per file`);

    expect(ZipArchive.open(createZip(['a', 'b', 'c'].map(name => declared(name, 64 * MiB)).concat(declared('d', 8 * MiB)))).entries).toHaveLength(4);
    const total = openError(createZip(['a', 'b', 'c', 'd'].map(name => declared(name, 60 * MiB))));
    expect(total.entry).toBe('d');
    expect(total.message).toContain(`more than the limit of ${200 * MiB} bytes`);
  });

  test('honours custom path limits', () => {
    const limits = { ...defaultZipLimits, maxPathBytes: 4 };
    expect(ZipArchive.open(createZip([{ name: 'abcd', data: 'x' }]), limits).entries).toHaveLength(1);
    expect(openError(createZip([{ name: 'abcde', data: 'x' }]), limits).message).toContain('5-byte name');
  });

  test('stops unpacking an entry that produces more than it declares', async () => {
    const declared = 64 * 1024;
    const bomb = new Uint8Array(100 * MiB);
    const archive = ZipArchive.open(createZip([{ name: 'bomb.js', data: bomb, size: declared }]));
    expect(archive.entries[0].compressedSize).toBeLessThan(200 * 1024);

    const error = await readError(archive, 'bomb.js') as ZipError;
    expect(error).toBeInstanceOf(ZipError);
    expect(error.entry).toBe('bomb.js');
    expect(error.message).toContain(`unpacks to more than the ${declared} bytes`);
    expect(error.produced).toBeGreaterThan(declared);
    expect(error.produced).toBeLessThanOrEqual(declared + 256 * 1024);
  });

  test('inflateRaw stops at its limit and reports how much it handed out', async () => {
    const input = deflateRawSync(new Uint8Array(100 * MiB));
    const error = await inflateRaw(input, 1000).catch((caught: unknown) => caught) as ZipError;
    expect(error).toBeInstanceOf(ZipError);
    expect(error.produced).toBeGreaterThan(1000);
    expect(error.produced).toBeLessThanOrEqual(1000 + 256 * 1024);
    expect(await inflateRaw(deflateRawSync(encoder.encode('hello')), 5)).toEqual(encoder.encode('hello'));
  });

  test('refuses an entry that produces less than it declares', async () => {
    const archive = ZipArchive.open(createZip([{ name: 'short.js', data: 'a'.repeat(50), size: 100 }]));
    const error = await readError(archive, 'short.js') as ZipError;
    expect(error).toBeInstanceOf(ZipError);
    expect(error.message).toContain('unpacks to 50 bytes, but its central directory record declares 100');
  });

  test('counts every read against the total limit of the archive', async () => {
    const archive = ZipArchive.open(createZip([{ name: 'a.txt', data: 'a'.repeat(60) }]), { ...defaultZipLimits, maxTotalSize: 100 });
    expect(await archive.read(archive.entries[0])).toHaveLength(60);
    const error = await readError(archive, 'a.txt') as ZipError;
    expect(error).toBeInstanceOf(ZipError);
    expect(error.message).toContain('past the limit of 100');
  });
});

describe('damaged and unsupported archives', () => {
  const plain: ZipTestEntry[] = [{ name: 'a.txt', data: 'alpha' }, { name: 'b.txt', data: 'beta' }];

  test.each([
    ['records counted as 0xFFFF', createZip(plain, { recordCount: 0xffff })],
    ['a directory offset of 0xFFFFFFFF', createZip(plain, { directoryOffset: 0xffffffff })],
    ['a ZIP64 locator', createZip(plain, { zip64Locator: true })],
  ])('refuses a ZIP64 archive marked by %s', (_, zip) => {
    expect(openError(zip).message).toContain('ZIP64');
  });

  test.each(['size', 'compressedSize'] as const)('refuses an entry with a ZIP64 %s', field => {
    const error = openError(createZip([{ name: 'big', data: 'x', [field]: 0xffffffff }]));
    expect(error.message).toContain('ZIP64');
    expect(error.entry).toBe('big');
  });

  test('refuses an entry with a ZIP64 local header offset', () => {
    expect(openError(createZip([{ name: 'big', data: 'x', localOffset: 0xffffffff }])).message).toContain('ZIP64');
  });

  test('refuses a split archive', () => {
    expect(openError(createZip(plain, { disk: 1 })).message).toContain('split');
  });

  test.each([
    ['in the central directory', { flags: 1, localFlags: 0 }],
    ['in the central directory', { flags: 1 << 6, localFlags: 0 }],
    ['in the local header', { localFlags: 1 }],
    ['in the local header', { localFlags: 1 << 6 }],
  ])('refuses an encryption flag %s: %j', (_, flags) => {
    const error = openError(createZip([{ name: 'secret.txt', data: 'x', ...flags }]));
    expect(error.entry).toBe('secret.txt');
    expect(error.message).toContain('encrypted');
  });

  test.each([1, 9, 12, 14, 93, 99])('refuses compression method %i', method => {
    const error = openError(createZip([{ name: 'odd.bin', data: 'x', method }]));
    expect(error.entry).toBe('odd.bin');
    expect(error.message).toContain(`compression method ${method}`);
  });

  test('refuses a stored entry whose sizes differ', () => {
    expect(openError(createZip([{ name: 'a', data: 'abc', method: 'store', compressedSize: 2 }])).message).toContain('stored uncompressed');
  });

  test('refuses a central directory with fewer records than the end record counts', () => {
    expect(openError(createZip(plain, { recordCount: 3 })).message).toContain('record 3 of 3');
  });

  test('refuses a central directory with bytes after its records', () => {
    expect(openError(createZip(plain, { recordCount: 1 })).message).toContain('more data than its 1 records');
  });

  test('refuses a central directory that was cut short', () => {
    const zip = createZip(plain);
    const { end } = findEndOfCentralDirectory(zip);
    expect(openError(cutBytes(zip, end - 10, end)).message).toContain('outside the archive');
  });

  test('refuses an archive without an end record', () => {
    const zip = createZip(plain);
    expect(openError(zip.subarray(0, zip.length - 1)).message).toContain('no end of central directory');
    expect(openError(new Uint8Array(10)).message).toContain('no end of central directory');
  });

  test('refuses entry data that runs into the central directory', () => {
    const error = openError(createZip([{ name: 'a.txt', data: 'abc', method: 'store', size: 50, compressedSize: 50 }]));
    expect(error.message).toContain('truncated');
    expect(error.entry).toBe('a.txt');
  });

  test('refuses a local header with a different name', () => {
    const error = openError(createZip([{ name: 'safe.txt', data: 'x', localName: '../evil.txt' }]));
    expect(error.entry).toBe('safe.txt');
    expect(error.message).toContain('different name in its local header');
  });

  test('refuses a local header with a different method', () => {
    expect(openError(createZip([{ name: 'a', data: 'x', localMethod: 0 }])).message).toContain('different compression method');
  });

  test('refuses a record that points at no local header', () => {
    expect(openError(createZip([{ name: 'a', data: 'x' }, { name: 'b', data: 'y', localOffset: 3 }])).message).toContain('no local header');
  });

  test('refuses entries whose data overlaps', () => {
    const zip = createZip([
      { name: 'a', data: 'a'.repeat(10), method: 'store', size: 40, compressedSize: 40 },
      { name: 'b', data: 'b'.repeat(10), method: 'store' },
    ]);
    const error = openError(zip);
    expect(error.entry).toBe('b');
    expect(error.message).toContain('overlaps the data of entry "a"');
  });

  test('refuses an entry whose CRC-32 does not match', async () => {
    const archive = ZipArchive.open(createZip([
      { name: 'stored.txt', data: 'stored', method: 'store', crc: crc32(encoder.encode('stored')) ^ 1 },
      { name: 'deflated.txt', data: 'deflated', crc: 0 },
    ]));
    for (const path of ['stored.txt', 'deflated.txt']) {
      const error = await readError(archive, path) as ZipError;
      expect(error).toBeInstanceOf(ZipError);
      expect(error.entry).toBe(path);
      expect(error.message).toContain('CRC-32');
    }
  });

  test('refuses damaged deflate data', async () => {
    const archive = ZipArchive.open(createZip([{ name: 'broken.js', data: 'abc', payload: Uint8Array.of(0xff, 0xff, 0xff) }]));
    const error = await readError(archive, 'broken.js') as ZipError;
    expect(error).toBeInstanceOf(ZipError);
    expect(error.message).toContain('"broken.js" could not be unpacked');
  });

  test('computes the standard CRC-32', () => {
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
  });
});
