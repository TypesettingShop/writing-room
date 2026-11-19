/**
 * A reader for ZIP archives held in memory, for packages that come from untrusted sources. It supports
 * stored (0) and deflated (8) entries and refuses everything else: ZIP64, split archives, encryption,
 * other compression methods. Every name is checked before anything is unpacked, and each entry is
 * unpacked on its own, stopping as soon as it produces more than its central directory record declares.
 */

export interface ZipLimits {
  /** Central directory records, folder and link records included. */
  readonly maxEntries: number;
  /** Unpacked bytes of all files: declared sizes when the archive is opened, actual bytes while reading. */
  readonly maxTotalSize: number;
  /** Unpacked size of one file. */
  readonly maxEntrySize: number;
  /** UTF-8 length of an entry name as stored in the archive. */
  readonly maxPathBytes: number;
}

const MiB = 1024 * 1024;

export const defaultZipLimits: ZipLimits = Object.freeze({
  maxEntries: 10_000,
  maxTotalSize: 200 * MiB,
  maxEntrySize: 64 * MiB,
  maxPathBytes: 512,
});

export class ZipError extends Error {
  /**
   * @param entry the entry's name as stored in the archive, when the problem belongs to one entry.
   * @param produced how many bytes the decompressor had handed out when unpacking stopped early.
   */
  constructor(message: string, readonly entry?: string, readonly produced?: number) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  /** Normalized relative path: '/' separators, no empty or '.' segments. */
  readonly path: string;
  /** Unpacked size from the central directory. */
  readonly size: number;
  readonly compressedSize: number;
}

const endOfCentralDirectorySignature = 0x06054b50;
const zip64LocatorSignature = 0x07064b50;
const centralDirectorySignature = 0x02014b50;
const localHeaderSignature = 0x04034b50;
const endOfCentralDirectoryLength = 22;
const zip64LocatorLength = 20;
const centralDirectoryHeaderLength = 46;
const localHeaderLength = 30;
const maxCommentLength = 0xffff;
const flagEncrypted = 1 << 0;
const flagStrongEncryption = 1 << 6;
const methodStored = 0;
const methodDeflated = 8;
const hostUnix = 3;
const fileTypeMask = 0o170000;
const fileTypeSymbolicLink = 0o120000;
/** Compressed input handed to the decompressor at a time, so a highly compressed run is fed in steps. */
const inflateInputSlice = 16 * 1024;

const controlCharacter = /[\u0000-\u001f\u007f-\u009f]/;
const driveLetter = /^[a-z]:/i;

interface EntryRecord {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly dataStart: number;
  readonly dataEnd: number;
}

function quote(name: string): string {
  return JSON.stringify(name);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as ZIP uses it (IEEE 802.3, reflected, initial and final XOR 0xFFFFFFFF). */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index++) {
    crc = crcTable[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Inflates raw deflate data. Output is collected up to `limit` bytes; the moment the decompressor hands
 * out more, the stream is cancelled and a ZipError carries the number of bytes it had handed out.
 */
export async function inflateRaw(input: Uint8Array<ArrayBuffer>, limit: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  let offset = 0;
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (offset >= input.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + inflateInputSlice, input.length);
      controller.enqueue(input.subarray(offset, end));
      offset = end;
    },
  }, { highWaterMark: 0 });
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw'), { signal }).getReader();
  const chunks: Uint8Array[] = [];
  let produced = 0;
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason;
        }
        throw new ZipError(`The deflate data is damaged: ${error instanceof Error ? error.message : String(error)}`, undefined, produced);
      }
      if (result.done) {
        break;
      }
      produced += result.value.length;
      if (produced > limit) {
        throw new ZipError(`The deflate data unpacks to more than ${limit} bytes.`, undefined, produced);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const output = new Uint8Array(produced);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
}

/**
 * Checks one entry name and returns its normalized path and whether it names a folder. The name is the one
 * stored in the archive; a folder record is a name that ends in '/'.
 */
function normalizeEntryName(name: string, label: string): { path: string; folder: boolean } {
  const fail = (reason: string): never => {
    throw new ZipError(`ZIP entry ${label} ${reason}.`, name);
  };
  if (!name) {
    fail('has an empty name');
  }
  if (controlCharacter.test(name)) {
    fail('has a NUL or control character in its name');
  }
  if (name.includes('\\')) {
    fail('has a backslash in its name; only \'/\' may separate folders');
  }
  if (name.startsWith('/')) {
    fail('is an absolute path');
  }
  if (driveLetter.test(name)) {
    fail('starts with a drive letter');
  }
  const segments = name.split('/');
  if (segments.includes('..')) {
    fail('has a \'..\' segment, which would leave the archive folder');
  }
  const path = segments.filter(segment => segment !== '' && segment !== '.').join('/');
  const folder = name.endsWith('/');
  if (!path && !folder) {
    fail('has no file name');
  }
  return { path, folder };
}

const nameDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class ZipArchive {
  readonly #bytes: Uint8Array<ArrayBuffer>;
  readonly #limits: ZipLimits;
  readonly #records: Map<ZipEntry, EntryRecord>;
  /** Bytes unpacked so far by every read of this archive, and bytes promised to reads still running. */
  #unpacked = 0;
  #reserved = 0;

  private constructor(
    bytes: Uint8Array<ArrayBuffer>,
    limits: ZipLimits,
    records: Map<ZipEntry, EntryRecord>,
    readonly warnings: readonly string[],
  ) {
    this.#bytes = bytes;
    this.#limits = limits;
    this.#records = records;
    this.entries = Object.freeze([...records.keys()]);
  }

  /** Files only: folder records are ignored, and symbolic links are left out with a warning. */
  readonly entries: readonly ZipEntry[];

  /** Reads the end record and the central directory and checks every name and declaration. */
  static open(input: Uint8Array, limits: ZipLimits = defaultZipLimits): ZipArchive {
    // A view over a shared buffer is copied once: the decompressor accepts only views of an ArrayBuffer.
    const bytes = input.buffer instanceof ArrayBuffer ? input as Uint8Array<ArrayBuffer> : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (offset: number) => view.getUint16(offset, true);
    const u32 = (offset: number) => view.getUint32(offset, true);

    // The end record sits at the very end, after a comment of at most 65,535 bytes.
    let end = -1;
    const searchFrom = Math.max(0, bytes.length - endOfCentralDirectoryLength - maxCommentLength);
    for (let offset = bytes.length - endOfCentralDirectoryLength; offset >= searchFrom; offset--) {
      if (u32(offset) === endOfCentralDirectorySignature && offset + endOfCentralDirectoryLength + u16(offset + 20) === bytes.length) {
        end = offset;
        break;
      }
    }
    if (end < 0) {
      throw new ZipError('Not a ZIP archive: no end of central directory record was found at the end of the data.');
    }
    const disk = u16(end + 4);
    const directoryDisk = u16(end + 6);
    const recordsOnDisk = u16(end + 8);
    const recordCount = u16(end + 10);
    const directorySize = u32(end + 12);
    const directoryOffset = u32(end + 16);
    if (recordCount === 0xffff || recordsOnDisk === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
      || (end >= zip64LocatorLength && u32(end - zip64LocatorLength) === zip64LocatorSignature)) {
      throw new ZipError('The archive is a ZIP64 archive, which is not supported.');
    }
    if (disk !== 0 || directoryDisk !== 0 || recordsOnDisk !== recordCount) {
      throw new ZipError('The archive is split across several files, which is not supported.');
    }
    if (recordCount > limits.maxEntries) {
      throw new ZipError(`The archive has ${recordCount} entries, more than the limit of ${limits.maxEntries}.`);
    }
    const directoryEnd = directoryOffset + directorySize;
    if (directoryEnd > end) {
      throw new ZipError('The central directory lies outside the archive; the archive is truncated or damaged.');
    }

    const records = new Map<ZipEntry, EntryRecord>();
    const warnings: string[] = [];
    const files = new Map<string, string>();
    const folders = new Map<string, string>();
    const ranges: { start: number; end: number; name: string }[] = [];
    let declaredTotal = 0;
    let offset = directoryOffset;
    for (let index = 0; index < recordCount; index++) {
      if (offset + centralDirectoryHeaderLength > directoryEnd || u32(offset) !== centralDirectorySignature) {
        throw new ZipError(`The central directory is truncated or damaged at record ${index + 1} of ${recordCount}.`);
      }
      const madeBy = u16(offset + 4);
      const flags = u16(offset + 8);
      const method = u16(offset + 10);
      const crc = u32(offset + 16);
      const compressedSize = u32(offset + 20);
      const size = u32(offset + 24);
      const nameLength = u16(offset + 28);
      const extraLength = u16(offset + 30);
      const commentLength = u16(offset + 32);
      const startDisk = u16(offset + 34);
      const externalAttributes = u32(offset + 38);
      const localOffset = u32(offset + 42);
      const nameStart = offset + centralDirectoryHeaderLength;
      const next = nameStart + nameLength + extraLength + commentLength;
      if (next > directoryEnd) {
        throw new ZipError(`The central directory is truncated or damaged at record ${index + 1} of ${recordCount}.`);
      }
      offset = next;

      const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
      let name: string;
      try {
        name = nameDecoder.decode(nameBytes);
      } catch {
        throw new ZipError(`ZIP entry ${index + 1} has a name that is not valid UTF-8.`);
      }
      const label = quote(name);
      if (nameLength > limits.maxPathBytes) {
        throw new ZipError(`ZIP entry ${label} has a ${nameLength}-byte name, longer than the limit of ${limits.maxPathBytes} bytes.`, name);
      }
      const { path, folder } = normalizeEntryName(name, label);

      if (madeBy >>> 8 === hostUnix && ((externalAttributes >>> 16) & fileTypeMask) === fileTypeSymbolicLink) {
        warnings.push(`Skipped symbolic link ${label}.`);
        continue;
      }
      if (folder) {
        if (path) {
          folders.set(path, name);
        }
        continue;
      }

      if (flags & (flagEncrypted | flagStrongEncryption)) {
        throw new ZipError(`ZIP entry ${label} is encrypted, which is not supported.`, name);
      }
      if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff || startDisk === 0xffff) {
        throw new ZipError(`ZIP entry ${label} uses ZIP64 sizes, which are not supported.`, name);
      }
      if (startDisk !== 0) {
        throw new ZipError(`ZIP entry ${label} starts on another disk of a split archive, which is not supported.`, name);
      }
      if (method !== methodStored && method !== methodDeflated) {
        throw new ZipError(`ZIP entry ${label} uses compression method ${method}; only stored (0) and deflated (8) are supported.`, name);
      }
      if (method === methodStored && compressedSize !== size) {
        throw new ZipError(`ZIP entry ${label} is stored uncompressed but declares ${compressedSize} stored bytes for ${size} unpacked bytes.`, name);
      }
      if (size > limits.maxEntrySize) {
        throw new ZipError(`ZIP entry ${label} unpacks to ${size} bytes, more than the limit of ${limits.maxEntrySize} bytes per file.`, name);
      }
      declaredTotal += size;
      if (declaredTotal > limits.maxTotalSize) {
        throw new ZipError(`The archive unpacks to more than the limit of ${limits.maxTotalSize} bytes (reached at entry ${label}).`, name);
      }
      const duplicate = files.get(path);
      if (duplicate !== undefined) {
        throw new ZipError(`ZIP entry ${label} has the same path as entry ${quote(duplicate)}.`, name);
      }
      files.set(path, name);

      // The local header must exist, name the same entry, and be followed by all of the entry's data.
      if (localOffset + localHeaderLength > directoryOffset || u32(localOffset) !== localHeaderSignature) {
        throw new ZipError(`ZIP entry ${label} has no local header where its central directory record points.`, name);
      }
      const localFlags = u16(localOffset + 6);
      const localNameLength = u16(localOffset + 26);
      const localExtraLength = u16(localOffset + 28);
      const localNameStart = localOffset + localHeaderLength;
      const localName = bytes.subarray(localNameStart, Math.min(localNameStart + localNameLength, directoryOffset));
      if (localName.length !== nameBytes.length || localName.some((byte, at) => byte !== nameBytes[at])) {
        throw new ZipError(`ZIP entry ${label} has a different name in its local header.`, name);
      }
      if (localFlags & (flagEncrypted | flagStrongEncryption)) {
        throw new ZipError(`ZIP entry ${label} is encrypted, which is not supported.`, name);
      }
      if (u16(localOffset + 8) !== method) {
        throw new ZipError(`ZIP entry ${label} has a different compression method in its local header.`, name);
      }
      const dataStart = localNameStart + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > directoryOffset) {
        throw new ZipError(`ZIP entry ${label} runs past the end of the archive data; the archive is truncated.`, name);
      }
      ranges.push({ start: localOffset, end: dataEnd, name });
      records.set(Object.freeze({ path, size, compressedSize }), { name, method, crc, dataStart, dataEnd });
    }
    if (offset !== directoryEnd) {
      throw new ZipError(`The central directory holds more data than its ${recordCount} records.`);
    }

    // A file path that is also a folder path would make one of the two unwritable ('a' and 'a/b').
    for (const path of files.keys()) {
      let slash = path.lastIndexOf('/');
      while (slash > 0) {
        const parent = path.slice(0, slash);
        if (!folders.has(parent)) {
          folders.set(parent, files.get(path)!);
        }
        slash = parent.lastIndexOf('/');
      }
    }
    for (const [path, name] of files) {
      const other = folders.get(path);
      if (other !== undefined) {
        throw new ZipError(`ZIP entry ${quote(name)} is a file, but entry ${quote(other)} uses the same path as a folder.`, name);
      }
    }

    // Entries whose bytes overlap would let a small archive unpack the same data many times over.
    ranges.sort((a, b) => a.start - b.start);
    for (let index = 1; index < ranges.length; index++) {
      if (ranges[index].start < ranges[index - 1].end) {
        throw new ZipError(`ZIP entry ${quote(ranges[index].name)} overlaps the data of entry ${quote(ranges[index - 1].name)}.`, ranges[index].name);
      }
    }

    return new ZipArchive(bytes, limits, records, Object.freeze(warnings));
  }

  /**
   * Unpacks one file. Stops with a ZipError the moment the output passes the declared size, and when the
   * archive's unpacked total, counting every read so far, would pass the limit. Checks the CRC-32.
   */
  async read(entry: ZipEntry, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    signal?.throwIfAborted();
    const record = this.#records.get(entry);
    if (!record) {
      throw new ZipError(`Entry ${quote(entry.path)} does not belong to this archive.`, entry.path);
    }
    const label = quote(record.name);
    const budget = this.#limits.maxTotalSize - this.#unpacked - this.#reserved;
    if (entry.size > budget) {
      throw new ZipError(`Reading ZIP entry ${label} would take the bytes unpacked from the archive past the limit of ${this.#limits.maxTotalSize}.`, record.name);
    }
    this.#reserved += entry.size;
    let produced = 0;
    try {
      let data: Uint8Array<ArrayBuffer>;
      const input = this.#bytes.subarray(record.dataStart, record.dataEnd);
      if (record.method === methodStored) {
        data = input.slice();
      } else {
        try {
          data = await inflateRaw(input, entry.size, signal);
        } catch (error) {
          if (error instanceof ZipError) {
            produced = error.produced ?? 0;
            const reason = produced > entry.size
              ? `unpacks to more than the ${entry.size} bytes its central directory record declares`
              : `could not be unpacked: ${error.message}`;
            throw new ZipError(`ZIP entry ${label} ${reason}.`, record.name, error.produced);
          }
          throw error;
        }
      }
      produced = data.length;
      if (data.length !== entry.size) {
        throw new ZipError(`ZIP entry ${label} unpacks to ${data.length} bytes, but its central directory record declares ${entry.size}.`, record.name);
      }
      if (crc32(data) !== record.crc) {
        throw new ZipError(`ZIP entry ${label} is damaged: its CRC-32 does not match.`, record.name);
      }
      return data;
    } finally {
      this.#reserved -= entry.size;
      this.#unpacked += produced;
    }
  }
}
