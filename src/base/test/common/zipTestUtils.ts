/**
 * Writes ZIP archives for tests, including deliberately broken ones. Test code only: it uses node:zlib.
 * Every field the reader checks can be overridden per entry or for the whole archive.
 */
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../common/zip.js';

export interface ZipTestEntry {
  /** The name as stored; a byte array is written as is (for names that are not valid UTF-8). */
  readonly name: string | Uint8Array;
  readonly data?: Uint8Array | string;
  /** 'store' (0) or 'deflate' (8); a number writes that method value without compressing. Default 'deflate'. */
  readonly method?: 'store' | 'deflate' | number;
  /** Bytes written as the entry's data instead of compressing `data`. */
  readonly payload?: Uint8Array;
  /** Unix mode; marks the record as made on Unix and stores the mode in the high 16 bits of the external attributes. */
  readonly unixMode?: number;
  /** General purpose flags, written to both headers. Default: bit 11 (UTF-8) when the name is not ASCII. */
  readonly flags?: number;
  /** Overrides the CRC-32 written to both headers. */
  readonly crc?: number;
  /** Overrides the unpacked size in both headers. */
  readonly size?: number;
  /** Overrides the compressed size in both headers (the payload written stays the same). */
  readonly compressedSize?: number;
  /** Writes a different name in the local header. */
  readonly localName?: string | Uint8Array;
  /** Writes different general purpose flags in the local header. */
  readonly localFlags?: number;
  /** Writes a different compression method in the local header. */
  readonly localMethod?: number;
  /** Overrides the local header offset in the central directory record. */
  readonly localOffset?: number;
  /** Overrides the disk where the entry starts. */
  readonly startDisk?: number;
}

export interface ZipTestOptions {
  /** The archive comment; a number writes that many bytes of 'x'. */
  readonly comment?: string | number;
  /** Overrides both record counts in the end record. */
  readonly recordCount?: number;
  readonly directorySize?: number;
  readonly directoryOffset?: number;
  /** Writes this disk number into the end record (split archives). */
  readonly disk?: number;
  /** Writes a ZIP64 end of central directory locator before the end record. */
  readonly zip64Locator?: boolean;
}

const encoder = new TextEncoder();

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? encoder.encode(value) : value;
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function header(length: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(length);
  write(new DataView(bytes.buffer));
  return bytes;
}

export function createZip(entries: readonly ZipTestEntry[], options: ZipTestOptions = {}): Uint8Array<ArrayBuffer> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = toBytes(entry.name);
    const data = toBytes(entry.data ?? '');
    const method = entry.method === 'store' ? 0 : entry.method === undefined || entry.method === 'deflate' ? 8 : entry.method;
    const payload = entry.payload ?? (method === 8 && typeof entry.method !== 'number' ? deflateRawSync(data) : data);
    const ascii = name.every(byte => byte < 0x80);
    const flags = entry.flags ?? (ascii ? 0 : 1 << 11);
    const crc = entry.crc ?? crc32(data);
    const size = entry.size ?? data.length;
    const compressedSize = entry.compressedSize ?? payload.length;
    const localName = entry.localName === undefined ? name : toBytes(entry.localName);
    const unix = entry.unixMode !== undefined;

    local.push(header(30, view => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, entry.localFlags ?? flags, true);
      view.setUint16(8, entry.localMethod ?? method, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, compressedSize, true);
      view.setUint32(22, size, true);
      view.setUint16(26, localName.length, true);
    }), localName, payload);
    central.push(header(46, view => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, unix ? (3 << 8) | 20 : 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, flags, true);
      view.setUint16(10, method, true);
      view.setUint32(16, crc, true);
      view.setUint32(20, compressedSize, true);
      view.setUint32(24, size, true);
      view.setUint16(28, name.length, true);
      view.setUint16(34, entry.startDisk ?? 0, true);
      view.setUint32(38, unix ? (entry.unixMode! << 16) >>> 0 : 0, true);
      view.setUint32(42, entry.localOffset ?? offset, true);
    }), name);
    offset += 30 + localName.length + payload.length;
  }

  const directory = concat(central);
  const comment = typeof options.comment === 'number' ? 'x'.repeat(options.comment) : options.comment ?? '';
  const commentBytes = encoder.encode(comment);
  const parts: Uint8Array[] = [...local, directory];
  if (options.zip64Locator) {
    parts.push(header(20, view => {
      view.setUint32(0, 0x07064b50, true);
      view.setUint32(16, 1, true);
    }));
  }
  parts.push(header(22, view => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, options.disk ?? 0, true);
    view.setUint16(6, options.disk ?? 0, true);
    view.setUint16(8, options.recordCount ?? entries.length, true);
    view.setUint16(10, options.recordCount ?? entries.length, true);
    view.setUint32(12, options.directorySize ?? directory.length, true);
    view.setUint32(16, options.directoryOffset ?? offset, true);
    view.setUint16(20, commentBytes.length, true);
  }), commentBytes);
  return concat(parts);
}

/** Byte offsets of the parts of an archive written by createZip, for cutting or patching it. */
export function findEndOfCentralDirectory(zip: Uint8Array): { end: number; directoryOffset: number; directorySize: number } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let end = zip.length - 22; end >= 0; end--) {
    if (view.getUint32(end, true) === 0x06054b50) {
      return { end, directoryOffset: view.getUint32(end + 16, true), directorySize: view.getUint32(end + 12, true) };
    }
  }
  throw new Error('No end of central directory record.');
}

/** A copy of the archive with the given bytes removed: [start, end). */
export function cutBytes(zip: Uint8Array, start: number, end: number): Uint8Array<ArrayBuffer> {
  return concat([zip.subarray(0, start), zip.subarray(end)]);
}

/** File and folder modes for `unixMode`. */
export const unixModes = Object.freeze({
  file: 0o100644,
  folder: 0o040755,
  symbolicLink: 0o120777,
});
