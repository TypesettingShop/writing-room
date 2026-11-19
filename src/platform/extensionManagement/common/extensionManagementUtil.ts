/**
 * Reads a VSIX package: a ZIP archive whose extension lives under `extension/`, next to
 * `extension.vsixmanifest` and `[Content_Types].xml` at the root. Only the manifest is unpacked here;
 * the other files are unpacked one at a time by whoever installs them.
 */
import { defaultZipLimits, ZipArchive, ZipError, type ZipEntry, type ZipLimits } from '../../../base/common/zip.js';
import { validateExtensionManifest } from '../../extensions/common/extensionValidator.js';
import { ExtensionIdentifier, type IExtensionManifest } from '../../extensions/common/extensions.js';

export const vsixLimits: { readonly download: number } & ZipLimits = Object.freeze({
  download: 50 * 1024 * 1024,
  ...defaultZipLimits,
});

/** The most `extension/package.json` and `extension.vsixmanifest` may unpack to. */
export const vsixManifestLimit = 256 * 1024;

export class VsixError extends Error {
  /** @param entry the archive entry the problem belongs to, as stored in the archive. */
  constructor(message: string, readonly entry?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VsixError';
  }
}

export interface VsixFile {
  /** Path relative to the extension folder, without the `extension/` prefix. */
  readonly path: string;
  readonly size: number;
}

export interface VsixPackage {
  /** The manifest exactly as it passed validateExtensionManifest. */
  readonly manifest: IExtensionManifest;
  /** `publisher.name` in lower case. */
  readonly identifier: string;
  /** TargetPlatform from extension.vsixmanifest: 'universal', 'web', or undefined when none is given. */
  readonly targetPlatform: string | undefined;
  /** Files under `extension/`, package.json included. */
  readonly files: readonly VsixFile[];
  /** Unpacked size of all files. */
  readonly size: number;
  /** Things that were left out, such as symbolic links. */
  readonly warnings: readonly string[];
  /** Unpacks one file. Each call counts against the package's unpacked total, so read each file once. */
  read(file: VsixFile, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
}

const extensionFolder = 'extension/';
const manifestPath = 'package.json';
const manifestEntry = extensionFolder + manifestPath;
const vsixManifestEntry = 'extension.vsixmanifest';
const installablePlatforms = new Set(['universal', 'web']);
const scheme = /^[a-z][a-z\d+.-]*:/i;
const forbiddenCharacter = /[\\?#\u0000-\u001f\u007f-\u009f]/;

/**
 * Whether a path from the manifest has the shape of a file inside the package: relative, '/' only,
 * no scheme, query or fragment, no backslash or control character, and no '..' that leaves the root.
 * It does not look at whether the file exists.
 */
export function isPackagePath(path: unknown): boolean {
  if (typeof path !== 'string' || !path || path.startsWith('/') || scheme.test(path) || forbiddenCharacter.test(path)) {
    return false;
  }
  let depth = 0;
  for (const segment of path.split('/')) {
    if (segment === '..') {
      if (--depth < 0) {
        return false;
      }
    } else if (segment !== '' && segment !== '.') {
      depth++;
    }
  }
  return depth > 0;
}

function toVsixError(error: unknown): unknown {
  return error instanceof ZipError ? new VsixError(error.message, error.entry, { cause: error }) : error;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decode(bytes: Uint8Array, entry: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new VsixError(`${entry} is not valid UTF-8 text.`, entry);
  }
}

async function readSmall(archive: ZipArchive, entry: ZipEntry, name: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (entry.size > vsixManifestLimit) {
    throw new VsixError(`${name} is ${entry.size} bytes, more than the limit of ${vsixManifestLimit} bytes.`, name);
  }
  // The read stops as soon as the entry produces more than its declared size, which is within the limit.
  return archive.read(entry, signal);
}

/** Finds TargetPlatform on the Identity element without an XML parser, so it also runs in a worker. */
function findTargetPlatform(xml: string): string | undefined {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  const identity = /<Identity\b([^>]*)>/.exec(text);
  if (!identity) {
    return undefined;
  }
  const attribute = /(?:^|\s)TargetPlatform\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(identity[1]);
  return attribute ? attribute[1] ?? attribute[2] : undefined;
}

/** Reads bytes as a VSIX. Unpacks only the manifests; the other files stay packed until read. */
export async function readVsix(bytes: Uint8Array, signal?: AbortSignal): Promise<VsixPackage> {
  signal?.throwIfAborted();
  if (bytes.length > vsixLimits.download) {
    throw new VsixError(`The package is ${bytes.length} bytes, more than the limit of ${vsixLimits.download} bytes.`);
  }
  try {
    const archive = ZipArchive.open(bytes, vsixLimits);
    const entries = new Map<VsixFile, ZipEntry>();
    let manifestZipEntry: ZipEntry | undefined;
    let vsixManifestZipEntry: ZipEntry | undefined;
    let size = 0;
    for (const entry of archive.entries) {
      if (entry.path === vsixManifestEntry) {
        vsixManifestZipEntry = entry;
      }
      if (!entry.path.startsWith(extensionFolder)) {
        continue;
      }
      const file: VsixFile = Object.freeze({ path: entry.path.slice(extensionFolder.length), size: entry.size });
      if (file.path === manifestPath) {
        manifestZipEntry = entry;
      }
      entries.set(file, entry);
      size += file.size;
    }
    if (!manifestZipEntry) {
      throw new VsixError(`The package has no ${manifestEntry}; it is not a VS Code extension package.`, manifestEntry);
    }

    let targetPlatform: string | undefined;
    if (vsixManifestZipEntry) {
      const xml = decode(await readSmall(archive, vsixManifestZipEntry, vsixManifestEntry, signal), vsixManifestEntry);
      targetPlatform = findTargetPlatform(xml);
      if (targetPlatform !== undefined && !installablePlatforms.has(targetPlatform)) {
        throw new VsixError(`The package is a platform-specific package for ${JSON.stringify(targetPlatform)}; only universal and web packages can be installed.`, vsixManifestEntry);
      }
    }

    const manifestBytes = await readSmall(archive, manifestZipEntry, manifestEntry, signal);
    let json: unknown;
    try {
      json = JSON.parse(decode(manifestBytes, manifestEntry));
    } catch (error) {
      if (error instanceof VsixError) {
        throw error;
      }
      throw new VsixError(`${manifestEntry} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, manifestEntry);
    }
    const { manifest, messages } = validateExtensionManifest(json, isPackagePath);
    if (!manifest) {
      const problems = messages.map(message => `${message.path}: ${message.message}`).join(' ');
      throw new VsixError(`${manifestEntry} is not a valid extension manifest. ${problems}`, manifestEntry);
    }

    return Object.freeze({
      manifest,
      identifier: ExtensionIdentifier.fromManifest(manifest).value,
      targetPlatform,
      files: Object.freeze([...entries.keys()]),
      size,
      warnings: archive.warnings,
      async read(file: VsixFile, readSignal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
        const entry = entries.get(file);
        if (!entry) {
          throw new VsixError(`${JSON.stringify(file.path)} is not a file of this package.`, extensionFolder + file.path);
        }
        if (entry === manifestZipEntry) {
          readSignal?.throwIfAborted();
          return manifestBytes.slice();
        }
        try {
          return await archive.read(entry, readSignal);
        } catch (error) {
          throw toVsixError(error);
        }
      },
    });
  } catch (error) {
    throw toVsixError(error);
  }
}
