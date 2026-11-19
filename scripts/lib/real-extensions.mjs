// Shared code for the real-extension cache: pins, integrity checks, bounded downloads, VSIX reading and
// path containment. The cached files are untrusted data. Every reader checks them against their pins.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const defaultPinsPath = join(repositoryRoot, 'test/fixtures/real-extensions/pins.json');
export const defaultCacheDir = join(repositoryRoot, 'test/fixtures/real-extensions/cache');

const MiB = 1024 * 1024;

// The limits come from the numbers table of epic wr-jbmd (VSIX and gallery rows).
export const limits = Object.freeze({
  vsix: 50 * MiB,
  signature: 1 * MiB,
  publicKey: 1 * MiB,
  sha256File: 1024,
  pins: 1 * MiB,
  unpacked: 200 * MiB,
  entries: 10_000,
  entry: 64 * MiB,
  pathBytes: 512,
});

export const allowedHosts = Object.freeze(['open-vsx.org', 'openvsx.eclipsecontent.org']);
export const requestTimeout = 30_000;
const maxRedirects = 3;

export class IntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrityError';
  }
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const hex64 = /^[0-9a-f]{64}$/;
const idPart = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const version = /^\d+\.\d+\.\d+$/;

function checkUrl(value, where) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${where}: not a URL`);
  }
  if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname) || url.username || url.password) {
    throw new Error(`${where}: must be an https URL on ${allowedHosts.join(' or ')}`);
  }
}

function checkPinnedFile(file, where, limit) {
  if (!file || typeof file !== 'object') {
    throw new Error(`${where}: missing`);
  }
  checkUrl(file.url, where + '.url');
  if (!hex64.test(file.sha256 ?? '')) {
    throw new Error(`${where}.sha256: expected 64 lowercase hex digits`);
  }
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > limit) {
    throw new Error(`${where}.size: expected a size between 1 and ${limit}`);
  }
}

export async function readPins(path = defaultPinsPath) {
  const info = await stat(path);
  if (info.size > limits.pins) {
    throw new Error(`${path}: larger than ${limits.pins} bytes`);
  }
  const pins = JSON.parse(await readFile(path, 'utf8'));
  if (!pins || typeof pins !== 'object' || !Array.isArray(pins.extensions) || !pins.publicKeys || typeof pins.publicKeys !== 'object') {
    throw new Error(`${path}: expected { publicKeys, extensions }`);
  }
  for (const [id, key] of Object.entries(pins.publicKeys)) {
    if (!idPart.test(id)) {
      throw new Error(`${path}: public key id ${JSON.stringify(id)} is not a plain identifier`);
    }
    checkPinnedFile(key, `publicKeys.${id}`, limits.publicKey);
  }
  const seen = new Set();
  pins.extensions.forEach((pin, index) => {
    const where = `extensions[${index}]`;
    if (!idPart.test(pin.namespace ?? '') || !idPart.test(pin.name ?? '') || pin.id !== `${pin.namespace}.${pin.name}`) {
      throw new Error(`${where}: id must be <namespace>.<name>`);
    }
    if (!version.test(pin.version ?? '')) {
      throw new Error(`${where}.version: expected major.minor.patch`);
    }
    if (seen.has(pin.id.toLowerCase())) {
      throw new Error(`${where}: ${pin.id} is pinned twice`);
    }
    seen.add(pin.id.toLowerCase());
    checkPinnedFile(pin.vsix, where + '.vsix', limits.vsix);
    checkPinnedFile(pin.signature, where + '.signature', limits.signature);
    checkUrl(pin.sha256File?.url, where + '.sha256File.url');
    if (!Object.hasOwn(pins.publicKeys, pin.publicKey)) {
      throw new Error(`${where}.publicKey: ${JSON.stringify(pin.publicKey)} is not in publicKeys`);
    }
  });
  return pins;
}

export function selectPins(pins, ids) {
  if (!ids.length) {
    return pins.extensions;
  }
  return ids.map(id => {
    const pin = pins.extensions.find(candidate => candidate.id.toLowerCase() === id.toLowerCase());
    if (!pin) {
      throw new Error(`${id} is not pinned. Pinned: ${pins.extensions.map(candidate => candidate.id).join(', ')}`);
    }
    return pin;
  });
}

export function packageBaseName(pin) {
  return `${pin.id}-${pin.version}`;
}

// The files one pin owns in the cache, with what each must hash to.
export function cachedFiles(pins, pin, cacheDir = defaultCacheDir) {
  const base = join(cacheDir, packageBaseName(pin));
  const key = pins.publicKeys[pin.publicKey];
  return {
    vsix: { path: base + '.vsix', url: pin.vsix.url, sha256: pin.vsix.sha256, limit: limits.vsix },
    signature: { path: base + '.sigzip', url: pin.signature.url, sha256: pin.signature.sha256, limit: limits.signature },
    sha256File: { path: base + '.sha256', url: pin.sha256File.url, limit: limits.sha256File },
    publicKey: { path: join(cacheDir, `public-key-${pin.publicKey}.pem`), url: key.url, sha256: key.sha256, limit: limits.publicKey },
  };
}

// Reads a cached file and checks it against its pin. Missing files return undefined; anything else that does not
// match throws, so a changed byte is never used.
export async function readVerified(file) {
  let info;
  try {
    info = await stat(file.path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  if (!info.isFile()) {
    throw new IntegrityError(`${file.path}: not a regular file`);
  }
  if (info.size > file.limit) {
    throw new IntegrityError(`${file.path}: ${info.size} bytes, more than the ${file.limit} byte limit`);
  }
  const bytes = await readFile(file.path);
  if (file.sha256 !== undefined && sha256(bytes) !== file.sha256) {
    throw new IntegrityError(`${file.path}: sha256 ${sha256(bytes)} does not match the pinned ${file.sha256}`);
  }
  return bytes;
}

// Writes bytes into the cache through a temporary file. The hash is computed again right before the write.
export async function writeVerified(file, bytes) {
  if (file.sha256 !== undefined && sha256(bytes) !== file.sha256) {
    throw new IntegrityError(`${file.url}: sha256 ${sha256(bytes)} does not match the pinned ${file.sha256}`);
  }
  await mkdir(dirname(file.path), { recursive: true });
  const temporary = `${file.path}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  try {
    await rename(temporary, file.path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function checkDownloadUrl(url) {
  if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname) || url.username || url.password) {
    throw new Error(`refusing to download from ${url.origin}: only https on ${allowedHosts.join(', ')}`);
  }
}

// Downloads without credentials and without automatic redirects. Each hop must stay on the allowed hosts, and the
// body is read up to the limit. The request carries no user or project information.
export async function download(urlText, limit, request = globalThis.fetch) {
  let url = new URL(urlText);
  const signal = AbortSignal.timeout(requestTimeout);
  for (let hop = 0; ; hop++) {
    checkDownloadUrl(url);
    const response = await request(url, { redirect: 'manual', credentials: 'omit', signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop >= maxRedirects) {
        throw new Error(`${urlText}: redirect without a location or more than ${maxRedirects} redirects`);
      }
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${url.href}: HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel();
      throw new Error(`${url.href}: ${declared} bytes, more than the ${limit} byte limit`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > limit) {
        throw new Error(`${url.href}: more than the ${limit} byte limit`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function checkEntryName(name, raw) {
  if (raw.byteLength > limits.pathBytes) {
    throw new IntegrityError(`zip entry name longer than ${limits.pathBytes} bytes`);
  }
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || /[\\\u0000-\u001f\u007f]/.test(name)) {
    throw new IntegrityError(`zip entry ${JSON.stringify(name)} is not a relative path`);
  }
  const segments = name.replace(/\/$/, '').split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new IntegrityError(`zip entry ${JSON.stringify(name)} has an empty, '.' or '..' segment`);
  }
}

// Reads a ZIP archive held in memory. It refuses path escapes, absolute names, duplicates (also by case), links,
// encryption and archives over the entry, size and count limits before any entry is inflated.
export function readZip(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) {
    throw new IntegrityError('not a zip archive: no end of central directory record');
  }
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new IntegrityError('zip64 archives are not supported');
  }
  if (count > limits.entries) {
    throw new IntegrityError(`zip archive has ${count} entries, more than ${limits.entries}`);
  }
  if (directoryOffset + directorySize > end) {
    throw new IntegrityError('zip central directory is outside the archive');
  }
  const entries = new Map();
  const folded = new Set();
  let total = 0;
  let offset = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new IntegrityError('zip central directory entry is damaged');
    }
    const madeBy = buffer.readUInt16LE(offset + 4) >> 8;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const attributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const raw = buffer.subarray(offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    let name;
    try {
      name = decoder.decode(raw);
    } catch {
      throw new IntegrityError('zip entry name is not UTF-8');
    }
    checkEntryName(name, raw);
    if (flags & 1) {
      throw new IntegrityError(`zip entry ${name} is encrypted`);
    }
    // Unix hosts keep the file type in the high 16 bits of the external attributes.
    if (madeBy === 3 && ((attributes >>> 16) & 0o170000) === 0o120000) {
      throw new IntegrityError(`zip entry ${name} is a symbolic link`);
    }
    const key = name.replace(/\/$/, '');
    if (folded.has(key.toLowerCase())) {
      throw new IntegrityError(`zip entry ${name} appears twice`);
    }
    folded.add(key.toLowerCase());
    const directory = name.endsWith('/');
    if (directory) {
      continue;
    }
    if (method !== 0 && method !== 8) {
      throw new IntegrityError(`zip entry ${name} uses compression method ${method}`);
    }
    if (size > limits.entry) {
      throw new IntegrityError(`zip entry ${name} is ${size} bytes, more than ${limits.entry}`);
    }
    total += size;
    if (total > limits.unpacked) {
      throw new IntegrityError(`zip archive unpacks to more than ${limits.unpacked} bytes`);
    }
    entries.set(name, { name, method, crc, compressedSize, size, localOffset });
  }
  return {
    names: [...entries.keys()],
    has: name => entries.has(name),
    read(name) {
      const entry = entries.get(name);
      if (!entry) {
        return undefined;
      }
      const local = entry.localOffset;
      if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
        throw new IntegrityError(`zip entry ${name} has no local header`);
      }
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      if (start + entry.compressedSize > buffer.length) {
        throw new IntegrityError(`zip entry ${name} runs past the archive`);
      }
      const data = buffer.subarray(start, start + entry.compressedSize);
      let content;
      try {
        content = entry.method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
      } catch (error) {
        throw new IntegrityError(`zip entry ${name} could not be inflated: ${error.message}`);
      }
      if (content.length !== entry.size || crc32(content) !== entry.crc) {
        throw new IntegrityError(`zip entry ${name} does not match its declared size or CRC`);
      }
      return content;
    },
  };
}

// Unpacks the `extension/` folder of a VSIX into a fresh folder, through a temporary sibling folder.
export async function extractVsix(bytes, destination) {
  const zip = readZip(bytes);
  const prefix = 'extension/';
  if (!zip.has(prefix + 'package.json')) {
    throw new IntegrityError('the VSIX has no extension/package.json');
  }
  const temporary = `${destination}.tmp-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  try {
    for (const name of zip.names) {
      if (!name.startsWith(prefix)) {
        continue;
      }
      const target = resolveContained(temporary, name.slice(prefix.length).split('/').map(encodeURIComponent).join('/'));
      if (!target) {
        throw new IntegrityError(`zip entry ${name} resolves outside the extension folder`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, zip.read(name), { flag: 'wx' });
    }
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

// The Ed25519 signature Open VSX publishes is over the raw VSIX bytes, in `.signature.sig` of the `.sigzip`.
export function verifyPackageSignature(vsix, sigzip, publicKeyPem) {
  const signature = readZip(sigzip).read('.signature.sig');
  if (!signature || signature.length !== 64) {
    throw new IntegrityError('the signature archive has no 64-byte .signature.sig');
  }
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new IntegrityError(`the public key is ${key.asymmetricKeyType}, not ed25519`);
  }
  return verify(null, vsix, key, signature);
}

// Maps a URL path below a folder to a file path inside it. Each segment is decoded once; encoded separators,
// control characters, backslashes and '.'/'..' segments are refused rather than normalized.
export function resolveContained(root, urlPath) {
  const base = resolve(root);
  if (typeof urlPath !== 'string' || urlPath.includes('?') || urlPath.includes('#')) {
    return undefined;
  }
  const segments = [];
  for (const segment of urlPath.replace(/^\//, '').split('/')) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (!decoded || decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f\u007f]/.test(decoded)) {
      return undefined;
    }
    segments.push(decoded);
  }
  const target = resolve(base, ...segments);
  return target.startsWith(base + sep) ? target : undefined;
}

export class MissingCacheError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingCacheError';
  }
}

// Reads every cached file of one pin and checks it: each against its own pin, the published .sha256 against the
// VSIX pin, and the Ed25519 signature over the VSIX bytes. Returns the verified bytes.
export async function verifyCachedPin(pins, pin, cacheDir = defaultCacheDir) {
  const files = cachedFiles(pins, pin, cacheDir);
  const bytes = {};
  for (const [kind, file] of Object.entries(files)) {
    bytes[kind] = await readVerified(file);
    if (!bytes[kind]) {
      throw new MissingCacheError(`${file.path} is not in the cache`);
    }
  }
  const published = new TextDecoder().decode(bytes.sha256File).trim().toLowerCase();
  if (published !== pin.vsix.sha256) {
    throw new IntegrityError(`${files.sha256File.path}: says ${published}, the pin says ${pin.vsix.sha256}`);
  }
  if (!verifyPackageSignature(bytes.vsix, bytes.signature, bytes.publicKey)) {
    throw new IntegrityError(`${files.vsix.path}: the Ed25519 signature in ${files.signature.path} does not verify`);
  }
  return bytes;
}

// The cache the real-extension tests need, checked offline. `problems` is empty when every pin is usable.
export async function checkCache(pinsPath = defaultPinsPath, cacheDir = defaultCacheDir) {
  const pins = await readPins(pinsPath);
  const problems = [];
  for (const pin of pins.extensions) {
    try {
      await verifyCachedPin(pins, pin, cacheDir);
    } catch (error) {
      problems.push(`${pin.id}@${pin.version}: ${error.message}`);
    }
  }
  return { pins, problems };
}
