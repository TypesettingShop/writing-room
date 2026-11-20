import { ThemeIcon } from '../../../../base/common/themables.js';
import { fetchBoundedResource, ResourceRequestError } from '../../../../base/parts/request/common/boundedFetch.js';
import { galleryId } from '../../../../platform/extensionManagement/common/extensionGalleryService.js';
import type { GalleryDownload, GalleryExtensionVersion } from '../../../../platform/extensionManagement/common/extensionGalleryService.js';
import { readVsix, vsixLimits } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { sha256Hex } from '../../../../platform/extensionManagement/common/extensionSignature.js';
import type { ExtensionSignature } from '../../../../platform/extensionManagement/common/extensionSignature.js';
import { readManifestNls } from '../../../../platform/extensionManagement/common/extensionNls.js';
import { isRecord, isValidExtensionVersion, validateExtensionManifest } from '../../../../platform/extensions/common/extensionValidator.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription, IExtensionManifest } from '../../../../platform/extensions/common/extensions.js';
import type { VsixFile, VsixPackage } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { product } from '../../../../platform/product/common/product.js';
import { extensionResourceLimits, resolveExtensionEntry, resolveExtensionPath } from '../../extensions/common/extensionResources.js';
import { IExtensionService } from '../../extensions/common/extensions.js';

export type ExtensionSource = 'location' | 'vsix' | 'gallery';
export type ExtensionSignatureState = ExtensionSignature['state'];

/** An installed extension record, storage schema 2. */
export interface StoredWebExtension {
  readonly identifier: string;
  readonly location: string;
  readonly manifest: IExtensionManifest;
  readonly installedAt: number;
  readonly source: ExtensionSource;
  readonly version: string;
  /** Lowercase hex SHA-256 of the package bytes; package sources only. */
  readonly packageSha256?: string;
  /** Package sources only. */
  readonly signature?: ExtensionSignatureState;
  readonly galleryUrl?: string;
  readonly nls?: Readonly<Record<string, string>>;
}

/** Replaces the installed list while the caller holds the installed-list lock. */
export type InstalledListWriter = (extensions: readonly StoredWebExtension[]) => Promise<void>;

export const IWebExtensionsScannerService = createDecorator<IWebExtensionsScannerService>('webExtensionsScannerService');

export interface IWebExtensionsScannerService extends BrandedService {
  /** The list this tab last saw. It can lag behind a write in another tab. */
  scanUserExtensions(): readonly StoredWebExtension[];
  /**
   * True while the installed list lives only in this tab because the workbench storage fell back to memory.
   * It can become true during an operation and then stays true.
   */
  readonly sessionOnly: boolean;
  /**
   * Runs `task` while this tab and every other tab of the origin are kept out of the installed list.
   * `read` returns the persisted list, not this tab's cache; while `sessionOnly`, it is this tab's list and no
   * Web Lock is taken, only this tab's order is kept. `locations` returns every location a persisted record
   * names, invalid records included, or undefined when the list cannot be parsed or is session-only. The lock
   * is not reentrant.
   */
  locked<T>(task: (
    read: () => readonly StoredWebExtension[], write: InstalledListWriter, locations: () => ReadonlySet<string> | undefined,
  ) => Promise<T>): Promise<T>;
}

/** Extracted package files waiting under a temporary folder of the package store. */
export interface StagedExtensionPackage {
  readonly identifier: string;
  readonly version: string;
}

export const IExtensionPackageStore = createDecorator<IExtensionPackageStore>('extensionPackageStore');

export interface IExtensionPackageStore extends BrandedService {
  /** False when the browser storage fell back to memory for this session. */
  isPersistent(): Promise<boolean>;
  /** Writes the package's files under a new temporary folder and checks that they all arrived. */
  stage(pkg: VsixPackage, signal?: AbortSignal, preloaded?: ReadonlyMap<VsixFile, Uint8Array<ArrayBuffer>>): Promise<StagedExtensionPackage>;
  /** Moves the staged files to their package folder in one storage transaction and returns its location. */
  commit(staged: StagedExtensionPackage, overwrite: boolean): Promise<string>;
  discard(staged: StagedExtensionPackage): Promise<void>;
  /** Removes `location` and everything below it when it is a package folder. */
  remove(location: string): Promise<void>;
  /** Removes temporary folders and package folders missing from `recorded` that are older than an hour. */
  cleanup(recorded: ReadonlySet<string>): Promise<void>;
}

export const IExtensionManagementService = createDecorator<ExtensionManagementService>('extensionManagementService');

/** Where a package came from, as the confirmation shows it. */
export type PackageInstallSource =
  | { readonly kind: 'vsix'; readonly label: string }
  | { readonly kind: 'gallery'; readonly label: string; readonly host: string; readonly keyId?: string; readonly license?: string };

type GalleryPackage = Omit<GalleryDownload, 'bytes'> & { readonly release: GalleryExtensionVersion };

/** What the person confirms. Every value describes the bytes that are installed after confirmation. */
export interface PackageInstallConfirmation {
  readonly identifier: string;
  readonly manifest: IExtensionManifest;
  /** The display name with its `%key%` placeholder replaced from the package's localized strings. */
  readonly displayName: string;
  readonly source: PackageInstallSource;
  /** Size of the package as received, in bytes. */
  readonly size: number;
  readonly sha256: string;
  readonly signature: ExtensionSignatureState;
  /** The `engines.vscode` range, which matched `product.version`. */
  readonly engine: string;
  /** Web entry or, for gallery installs, a declarative package without a host entry. */
  readonly isWebExtension: boolean;
  /** The record this install replaces (another version) or reinstalls (the same version). */
  readonly existing?: Pick<StoredWebExtension, 'version' | 'source'>;
  /** False when the installed list or the package files are kept for this session only. */
  readonly persistent: boolean;
  readonly warnings: readonly string[];
}

/** What the folder URL install confirmation is told about the install's lifetime. */
export interface LocationInstallConfirmation {
  /** False when the installed list is kept for this session only. A folder install writes no files. */
  readonly persistent: boolean;
}

/**
 * The installed list lives only in this tab while the package files persist: other tabs and the next start would
 * see the files without any record this tab could keep, so a package is not installed here.
 */
export const sessionListPackageError = 'Workbench storage is unavailable in this tab, so a package cannot be kept here.'
  + ' Reload the page and try again.';

export const installLifetimeChangedError = 'Browser storage became unavailable after the confirmation, so the extension was not installed.'
  + ' Install it again to keep it for this session only.';

export interface PackageInstallOptions {
  readonly signal?: AbortSignal;
  /** The display language whose `package.nls.<language>.json` is read besides `package.nls.json`. */
  readonly language?: string;
}

export { sha256Hex };

function readNlsBundle(bytes: Uint8Array, path: string): Record<string, string> {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!isRecord(value)) {
    throw new Error(path + ' must contain a JSON object.');
  }
  return readManifestNls(value);
}

/** The folder that holds every package folder, as a location string. */
export const extensionPackageRoot = 'vscode-userdata:/extensions/';

/** The only place a package of this identifier and version may run from. */
export function extensionPackageLocation(identifier: string, version: string): string {
  return extensionPackageRoot + identifier.toLowerCase() + '-' + version + '/';
}

export function isExtensionPackageLocation(location: string): boolean {
  return location.startsWith(extensionPackageRoot);
}

export function normalizeExtensionLocation(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter an absolute URL for the extension directory.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS or HTTP on localhost or 127.0.0.1.');
  }
  if (url.username || url.password) {
    throw new Error('The extension URL must not contain credentials.');
  }
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url;
}

/** The display name, with a `%key%` placeholder replaced from the extension's localized strings. */
export function localizedDisplayName(manifest: IExtensionManifest, nls: Readonly<Record<string, string>> | undefined): string {
  const name = manifest.displayName ?? manifest.name;
  const key = /^%(.+)%$/.exec(name)?.[1];
  return (key && nls?.[key]) || name;
}

/** Whether `value` names a `.vsix` file rather than an extension folder. */
export function isPackageUrl(value: string): boolean {
  try {
    return new URL(value.trim()).pathname.toLowerCase().endsWith('.vsix');
  } catch {
    return false;
  }
}

/** The folder URL rules, for a `.vsix` file: the query stays, as a download link may need it. */
export function normalizePackageUrl(value: string): URL {
  normalizeExtensionLocation(value);
  const original = new URL(value.trim());
  original.hash = '';
  if (!original.pathname.toLowerCase().endsWith('.vsix')) {
    throw new Error('Enter the URL of a .vsix file.');
  }
  return original;
}

/** Whether the manifest has `%key%` values that a `package.nls.json` replaces. */
export function usesNlsPlaceholders(manifest: IExtensionManifest): boolean {
  return /"%[^"%\\]+%"/.test(JSON.stringify(manifest));
}

export function validateInstalledManifest(input: unknown, location: string): IExtensionManifest {
  const resolve = (path: string) => resolveExtensionPath(location, path);
  const { manifest, messages } = validateExtensionManifest(input, resolve);
  if (!manifest) {
    throw new Error(messages.map(({ path, message }) => path + ': ' + message).join(' '));
  }
  const validateIcon = (entry: unknown, path: string) => {
    if (isRecord(entry) && entry.icon !== undefined) {
      if (typeof entry.icon !== 'string' || (!ThemeIcon.fromString(entry.icon) && !resolve(entry.icon))) {
        throw new Error(path + '.icon: Expected a codicon or a path inside the extension directory.');
      }
    }
  };
  const containers = manifest.contributes?.viewsContainers;
  if (isRecord(containers)) {
    for (const [key, entries] of Object.entries(containers)) {
      if (Array.isArray(entries)) {
        entries.forEach((entry, index) => validateIcon(entry, 'contributes.viewsContainers.' + key + '.' + index));
      }
    }
  }
  return manifest;
}

const sources: ReadonlySet<unknown> = new Set<ExtensionSource>(['location', 'vsix', 'gallery']);
const signatures: ReadonlySet<unknown> = new Set<ExtensionSignatureState>(['verified', 'unsigned', 'unverifiable']);

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}

/**
 * Validates one saved record of schema 2. The location must be the record's own package folder, or a
 * folder URL for a `location` install, so an edited record cannot point at another extension's code.
 */
export function validateStoredExtension(entry: unknown): StoredWebExtension {
  if (!isRecord(entry) || typeof entry.identifier !== 'string' || typeof entry.location !== 'string'
    || typeof entry.installedAt !== 'number' || !Number.isFinite(entry.installedAt) || entry.installedAt < 0
    || !sources.has(entry.source) || typeof entry.version !== 'string') {
    throw new Error('Invalid installed extension record.');
  }
  const source = entry.source as ExtensionSource;
  let location: string;
  if (source === 'location') {
    location = normalizeExtensionLocation(entry.location).href;
  } else {
    if (entry.location !== extensionPackageLocation(entry.identifier, entry.version)
      || typeof entry.packageSha256 !== 'string' || !/^[\da-f]{64}$/.test(entry.packageSha256)
      || !signatures.has(entry.signature)) {
      throw new Error(`Invalid package record for '${entry.identifier}'.`);
    }
    location = entry.location;
  }
  const manifest = validateInstalledManifest(entry.manifest, location);
  const identifier = ExtensionIdentifier.fromManifest(manifest).value;
  if (entry.identifier !== identifier || entry.version !== manifest.version) {
    throw new Error(`The record of '${entry.identifier}' does not match its manifest.`);
  }
  if (entry.galleryUrl !== undefined && (source !== 'gallery' || typeof entry.galleryUrl !== 'string')) {
    throw new Error(`Invalid gallery URL for '${identifier}'.`);
  }
  if (entry.nls !== undefined && !isStringRecord(entry.nls)) {
    throw new Error(`Invalid localized strings for '${identifier}'.`);
  }
  return {
    identifier, location, manifest, installedAt: entry.installedAt, source, version: entry.version,
    ...(source === 'location' ? {} : {
      packageSha256: entry.packageSha256 as string, signature: entry.signature as ExtensionSignatureState,
    }),
    ...(entry.galleryUrl === undefined ? {} : { galleryUrl: entry.galleryUrl as string }),
    ...(entry.nls === undefined ? {} : { nls: entry.nls as Record<string, string> }),
  };
}

export function toExtensionDescription(
  extension: Pick<StoredWebExtension, 'identifier' | 'location' | 'manifest' | 'nls'>,
): IExtensionDescription {
  const { identifier, location, manifest, nls } = extension;
  return { identifier: new ExtensionIdentifier(identifier), location, manifest, isBuiltin: false, ...(nls ? { nls } : {}) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateGalleryPackage(pkg: VsixPackage, release: GalleryExtensionVersion): void {
  const { manifest } = pkg;
  if (pkg.identifier !== release.id || manifest.version !== release.version) {
    throw new Error('The package identifier or version does not match Open VSX metadata.');
  }
  if (!release.isWebExtension || (manifest.browser === undefined && manifest.main !== undefined)) {
    throw new Error('The downloaded package is not a web extension.');
  }
  if (release.hasExtensionPack || (manifest.extensionPack !== undefined
    && (!Array.isArray(manifest.extensionPack) || manifest.extensionPack.length !== 0))) {
    throw new Error('Open VSX extension packs are not supported.');
  }
  const dependencies = manifest.extensionDependencies ?? [];
  const expected = new Set(release.dependencies.map(galleryId));
  if (!Array.isArray(dependencies) || !dependencies.every(id => typeof id === 'string' && expected.has(id.toLowerCase()))
    || new Set(dependencies.map(id => id.toLowerCase())).size !== expected.size) {
    throw new Error('The package dependencies do not match Open VSX metadata.');
  }
}

export class ExtensionManagementService {
  declare readonly _serviceBrand: undefined;
  private readonly pendingLocations = new Map<string, Promise<IExtensionDescription | undefined>>();
  private readonly pendingPackages = new Map<string, Promise<IExtensionDescription | undefined>>();
  private changes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fetchManifest: typeof fetch,
    @IWebExtensionsScannerService private readonly scanner: IWebExtensionsScannerService,
    @IExtensionService private readonly active: IExtensionService,
    @IExtensionPackageStore private readonly packages: IExtensionPackageStore,
  ) {}

  get installed(): readonly IExtensionDescription[] {
    return this.active.extensions?.filter(extension => !extension.isBuiltin) ?? [];
  }

  async installFromLocation(
    value: string,
    confirm: (extension: IExtensionDescription, lifetime: LocationInstallConfirmation) => Promise<boolean>,
  ): Promise<IExtensionDescription | undefined> {
    await this.active.whenInstalledExtensionsRegistered();
    const location = normalizeExtensionLocation(value);
    const existing = this.pendingLocations.get(location.href);
    if (existing) {
      return existing;
    }
    const request = this.install(location, confirm).finally(() => this.pendingLocations.delete(location.href));
    this.pendingLocations.set(location.href, request);
    return request;
  }

  private async install(
    location: URL,
    confirm: (extension: IExtensionDescription, lifetime: LocationInstallConfirmation) => Promise<boolean>,
  ): Promise<IExtensionDescription | undefined> {
    const manifest = validateInstalledManifest(await this.loadManifest(location), location.href);
    const identifier = ExtensionIdentifier.fromManifest(manifest).value;
    // Removal unregisters before deactivation and the catalog write. A reinstall from the palette may
    // be requested as soon as the views disappear, so wait for any already queued removal first.
    await this.changes;
    this.ensureAvailable(identifier, this.scanner.scanUserExtensions());
    const nls = usesNlsPlaceholders(manifest) ? await this.loadNls(location) : undefined;
    const description = toExtensionDescription({ identifier, location: location.href, manifest, nls });
    const confirmedPersistent = !this.scanner.sessionOnly;
    if (!await confirm(description, { persistent: confirmedPersistent })) {
      return undefined;
    }
    const record: StoredWebExtension = {
      identifier, location: location.href, manifest, installedAt: Date.now(), source: 'location', version: manifest.version,
      ...(nls ? { nls } : {}),
    };
    return this.serialize(async () => {
      // A folder install has no files to stage, so it registers first: its commands are there as soon as the
      // confirmation closes, not only after the cross-tab lock is granted. A failed write unregisters it again.
      this.ensureAvailable(identifier, this.scanner.scanUserExtensions());
      if (!this.active.addExtension?.(description)) {
        throw new Error(`Could not register extension '${identifier}'.`);
      }
      try {
        await this.scanner.locked(async (read, write) => {
          const installed = read();
          if (installed.some(entry => entry.identifier === identifier)) {
            throw new Error(`'${identifier}' is already installed. Uninstall it before replacing it.`);
          }
          if (confirmedPersistent && this.scanner.sessionOnly) {
            throw new Error(installLifetimeChangedError);
          }
          await write([...installed, record]);
        });
      } catch (error) {
        this.active.removeExtension?.(identifier);
        throw error;
      }
      return description;
    });
  }

  /**
   * Runs the part of an install or removal that changes records, folders and registrations, one at a time in
   * this tab. Without it a removal could run between an install's record write and its registration.
   */
  private serialize<T>(change: () => Promise<T>): Promise<T> {
    const result = this.changes.then(change);
    this.changes = result.catch(() => {});
    return result;
  }

  /**
   * Installs a VSIX package from bytes already in memory. Nothing is written before `confirm` resolves to
   * true, and what is written are these bytes, not a second download.
   */
  async installPackage(
    bytes: Uint8Array<ArrayBuffer>,
    source: Extract<PackageInstallSource, { kind: 'vsix' }>,
    confirm: (confirmation: PackageInstallConfirmation) => Promise<boolean>,
    options: PackageInstallOptions = {},
  ): Promise<IExtensionDescription | undefined> {
    return this.installPackageBytes(bytes, source, confirm, options);
  }

  installFromGallery(
    release: GalleryExtensionVersion,
    download: GalleryDownload,
    confirm: (confirmation: PackageInstallConfirmation) => Promise<boolean>,
    options: PackageInstallOptions = {},
  ): Promise<IExtensionDescription | undefined> {
    const { bytes, ...verified } = download;
    return this.installPackageBytes(bytes, {
      kind: 'gallery', label: new URL(release.download).host, host: verified.host,
      ...(verified.signature.state === 'unsigned' ? {} : { keyId: verified.signature.keyId }),
      ...(release.license ? { license: release.license } : {}),
    }, confirm, options, { ...verified, release });
  }

  private async installPackageBytes(
    bytes: Uint8Array<ArrayBuffer>,
    source: PackageInstallSource,
    confirm: (confirmation: PackageInstallConfirmation) => Promise<boolean>,
    options: PackageInstallOptions,
    gallery?: GalleryPackage,
  ): Promise<IExtensionDescription | undefined> {
    await this.active.whenInstalledExtensionsRegistered();
    if (bytes.byteLength > vsixLimits.download) {
      throw new Error(`The package is ${bytes.byteLength} bytes, more than the ${vsixLimits.download}-byte limit.`);
    }
    const sha256 = await sha256Hex(bytes);
    options.signal?.throwIfAborted();
    if (gallery && sha256 !== gallery.sha256) {
      throw new Error('The package bytes no longer match the verified Open VSX checksum.');
    }
    // A local install of identical bytes must not supply the confirmation or source of a gallery install.
    const key = gallery ? `gallery:${gallery.release.id}:${gallery.release.version}:${sha256}` : sha256;
    const existing = this.pendingPackages.get(key);
    if (existing) {
      return existing;
    }
    const request = this.doInstallPackage(bytes, sha256, source, confirm, options, gallery)
      .finally(() => this.pendingPackages.delete(key));
    this.pendingPackages.set(key, request);
    return request;
  }

  private async doInstallPackage(
    bytes: Uint8Array<ArrayBuffer>, sha256: string, source: PackageInstallSource,
    confirm: (confirmation: PackageInstallConfirmation) => Promise<boolean>, { signal, language = 'en' }: PackageInstallOptions,
    gallery: GalleryPackage | undefined,
  ): Promise<IExtensionDescription | undefined> {
    const pkg = await readVsix(bytes, signal);
    const { identifier } = pkg;
    const version = pkg.manifest.version;
    const location = extensionPackageLocation(identifier, version);
    const manifest = validateInstalledManifest(pkg.manifest, location);
    if (gallery) {
      validateGalleryPackage(pkg, gallery.release);
    }
    const signature = gallery?.signature.state ?? 'unsigned';
    const engine = manifest.engines?.vscode;
    if (typeof engine !== 'string' || !isValidExtensionVersion(product.version, engine)) {
      throw new Error(engine === undefined
        ? `'${identifier}' does not declare engines.vscode.`
        : `'${identifier}' requires VS Code ${engine}, which does not include ${product.version}.`);
    }
    if (manifest.browser !== undefined) {
      const entry = resolveExtensionEntry(location, manifest.browser);
      const path = entry && decodeURIComponent(entry.href.slice(location.length));
      const file = pkg.files.find(candidate => candidate.path === path);
      if (!file) {
        throw new Error(`The browser entry '${manifest.browser}' of '${identifier}' is not in the package.`);
      }
      if (file.size > extensionResourceLimits.packageEntry) {
        throw new Error(`The browser entry '${path}' is ${file.size} bytes, more than the ${extensionResourceLimits.packageEntry}-byte limit.`);
      }
    }
    if (this.active.extensions?.some(entry => entry.isBuiltin && entry.identifier.value === identifier)) {
      throw new Error(`'${identifier}' is a built-in extension.`);
    }
    const warnings = [...pkg.warnings];
    // Files read before the confirmation are handed to the store, so no file is unpacked twice.
    const preloaded = new Map<VsixFile, Uint8Array<ArrayBuffer>>();
    const nls = usesNlsPlaceholders(manifest) ? await this.readPackageNls(pkg, language, warnings, preloaded, signal) : undefined;
    // As for a folder install: a queued removal still has its record, which would be shown as the version this
    // install replaces and then fail the commit as a change from another window.
    await this.changes;
    const previous = this.scanner.scanUserExtensions().find(entry => entry.identifier === identifier);
    // Refused before the confirmation, so nobody accepts an install that cannot happen.
    const persistent = this.packageLifetime(await this.packages.isPersistent());
    const confirmed = await confirm({
      identifier, manifest, displayName: localizedDisplayName(manifest, nls), source, size: bytes.byteLength, sha256, signature, engine,
      isWebExtension: gallery !== undefined || manifest.browser !== undefined,
      existing: previous && { version: previous.version, source: previous.source },
      persistent, warnings,
    });
    if (!confirmed) {
      return undefined;
    }

    signal?.throwIfAborted();
    const record: StoredWebExtension = {
      identifier, location, manifest, installedAt: Date.now(), source: source.kind, version,
      packageSha256: sha256, signature, ...(nls ? { nls } : {}),
      ...(gallery ? { galleryUrl: gallery.release.download } : {}),
    };
    return this.serialize(() => this.commitPackage(pkg, record, previous, persistent, preloaded, signal));
  }

  /**
   * True when both the installed list and the package files persist, false when the install lasts for this
   * session. Throws when only the list is session-only, which leaves no way to keep the package files to it.
   */
  private packageLifetime(filesPersist: boolean): boolean {
    const listSessionOnly = this.scanner.sessionOnly;
    if (listSessionOnly && filesPersist) {
      throw new Error(sessionListPackageError);
    }
    return filesPersist && !listSessionOnly;
  }

  private async commitPackage(
    pkg: VsixPackage, record: StoredWebExtension, previous: StoredWebExtension | undefined, confirmedPersistent: boolean,
    preloaded: ReadonlyMap<VsixFile, Uint8Array<ArrayBuffer>>, signal: AbortSignal | undefined,
  ): Promise<IExtensionDescription> {
    const { identifier, location } = record;
    signal?.throwIfAborted();
    const staged = await this.packages.stage(pkg, signal, preloaded);
    const replaced = this.installed.find(extension => extension.identifier.value === identifier);
    let stoppedPrevious = false;
    let committed = false;
    try {
      await this.scanner.locked(async (read, write) => {
        signal?.throwIfAborted();
        const installed = read();
        if (record.source === 'gallery') {
          const missing = record.manifest.extensionDependencies?.find(id => {
            const dependency = id.toLowerCase();
            return !installed.some(entry => entry.identifier === dependency)
              && !this.active.extensions?.some(entry => entry.isBuiltin && entry.identifier.value === dependency);
          });
          if (missing) {
            throw new Error(`'${missing}' is no longer installed. Try again.`);
          }
        }
        const current = installed.find(entry => entry.identifier === identifier);
        if (current?.location !== previous?.location || current?.installedAt !== previous?.installedAt) {
          throw new Error(`'${identifier}' changed in another window during the install. Try again.`);
        }
        // The old generation can still save state/read package resources during deactivate.
        if (replaced && this.active.removeExtension?.(identifier)) {
          stoppedPrevious = true;
          await this.active.whenExtensionRemoved?.(identifier);
        }
        // The storage can fall back to memory after the confirmation. A session-only list must not move a
        // package into persistent files, where it could replace a folder that a record this tab cannot see uses.
        const persistent = this.packageLifetime(await this.packages.isPersistent());
        if (confirmedPersistent && !persistent) {
          throw new Error(installLifetimeChangedError);
        }
        // Only `current` can name this identifier and version. A folder there that it does not use is left
        // over from an interrupted install or a failed removal, and is replaced rather than blocking the install.
        await this.packages.commit(staged, true);
        committed = true;
        try {
          // The storage can also fall back while the folder moves. Checked with no await before the write, so a
          // session-only record never names a package folder in persistent files.
          if (persistent && this.scanner.sessionOnly) {
            throw new Error(sessionListPackageError);
          }
          await write([...installed.filter(entry => entry.identifier !== identifier), record]);
        } catch (error) {
          await this.removeUnreferenced(location, installed);
          throw error;
        }
      });
    } catch (error) {
      if (!committed) {
        await this.packages.discard(staged).catch(cleanup => console.warn('Could not remove a staged extension package.', cleanup));
      }
      if (stoppedPrevious && replaced) {
        this.registerAgain(replaced);
      }
      throw error;
    }

    const description = toExtensionDescription(record);
    try {
      if (!this.active.addExtension?.(description)) {
        throw new Error(`Could not register extension '${identifier}'.`);
      }
    } catch (error) {
      if (previous?.location === location) {
        // A reinstall already replaced the files that the previous record described. The new record matches them,
        // so it stays, and the extension registers from it when the workbench starts again.
        throw new Error(`${describe(error)} The reinstalled package is kept and loads after a reload.`, { cause: error });
      }
      await this.restore(record, previous).catch(cleanup => console.error(`Could not restore the record of '${identifier}'.`, cleanup));
      if (replaced) {
        this.registerAgain(replaced);
      }
      throw error;
    }
    if (previous && previous.location !== location) {
      await this.scanner.locked(async read => this.removeUnreferenced(previous.location, read()))
        .catch(error => console.warn(`Could not remove the replaced package of '${identifier}'.`, error));
    }
    return description;
  }

  private async readPackageNls(
    pkg: VsixPackage, language: string, warnings: string[], preloaded: Map<VsixFile, Uint8Array<ArrayBuffer>>, signal?: AbortSignal,
  ): Promise<Record<string, string> | undefined> {
    let result: Record<string, string> | undefined;
    const paths = ['package.nls.json'];
    if (language.toLowerCase() !== 'en') {
      paths.push('package.nls.' + language.toLowerCase() + '.json');
    }
    for (const path of paths) {
      const file = pkg.files.find(candidate => candidate.path.toLowerCase() === path);
      if (!file) {
        continue;
      }
      if (file.size > extensionResourceLimits.nls) {
        warnings.push(`Ignored ${file.path}: it is larger than ${extensionResourceLimits.nls} bytes.`);
        continue;
      }
      try {
        const bytes = await pkg.read(file, signal);
        preloaded.set(file, bytes);
        result = { ...result, ...readNlsBundle(bytes, file.path) };
      } catch (error) {
        warnings.push(`Ignored ${file.path}: ${describe(error)}`);
      }
    }
    return result;
  }

  /** Puts `previous` back, or removes `record`, unless another write replaced `record` meanwhile. */
  private restore(record: StoredWebExtension, previous: StoredWebExtension | undefined): Promise<void> {
    return this.scanner.locked(async (read, write) => {
      const installed = read();
      const current = installed.find(entry => entry.identifier === record.identifier);
      if (current?.location !== record.location || current.installedAt !== record.installedAt) {
        return;
      }
      const restored = [...installed.filter(entry => entry !== current), ...previous ? [previous] : []];
      await write(restored);
      await this.removeUnreferenced(record.location, restored);
    });
  }

  private ensureAvailable(identifier: string, installed: readonly StoredWebExtension[]): void {
    const extension = this.active.extensions?.find(entry => entry.identifier.value === identifier);
    if (extension?.isBuiltin) {
      throw new Error(`'${identifier}' is a built-in extension.`);
    }
    if (extension || installed.some(entry => entry.identifier === identifier)) {
      throw new Error(`'${identifier}' is already installed. Uninstall it before replacing it.`);
    }
  }

  private async loadManifest(location: URL): Promise<unknown> {
    const manifestUrl = new URL('package.json', location);
    let text: string;
    try {
      const { bytes } = await fetchBoundedResource(manifestUrl, {
        limit: extensionResourceLimits.manifest, request: this.fetchManifest,
      });
      text = new TextDecoder().decode(bytes);
    } catch (error) {
      if (error instanceof ResourceRequestError) {
        throw new Error(`Cannot fetch the manifest from ${location.origin}. The server may be unavailable, may require a redirect, or may not allow cross-origin requests (CORS).`);
      }
      throw new Error(`Could not read package.json from ${location.origin}: ${describe(error)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('The extension package.json must contain valid JSON.');
    }
  }

  /** Reads `package.nls.json` next to a folder install's manifest. A missing or unreadable file is skipped. */
  private async loadNls(location: URL): Promise<Record<string, string> | undefined> {
    try {
      const { bytes } = await fetchBoundedResource(new URL('package.nls.json', location), {
        limit: extensionResourceLimits.nls, request: this.fetchManifest,
      });
      return readNlsBundle(bytes, 'package.nls.json');
    } catch (error) {
      console.warn(`Installing without localized manifest strings from ${location.href}.`, error);
      return undefined;
    }
  }

  /** Downloads a `.vsix` once, up to the package limit, and installs exactly those bytes. */
  async installFromPackageUrl(
    value: string,
    confirm: (confirmation: PackageInstallConfirmation) => Promise<boolean>,
    options: PackageInstallOptions = {},
  ): Promise<IExtensionDescription | undefined> {
    await this.active.whenInstalledExtensionsRegistered();
    const url = normalizePackageUrl(value);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      ({ bytes } = await fetchBoundedResource(url, {
        limit: vsixLimits.download, request: this.fetchManifest, signal: options.signal, idleTimeout: true,
      }));
    } catch (error) {
      if (error instanceof ResourceRequestError) {
        throw new Error(`Cannot download the package from ${url.origin}. The server may be unavailable, may require a redirect, or may not allow cross-origin requests (CORS).`);
      }
      throw new Error(`Could not download the package from ${url.origin}: ${describe(error)}`);
    }
    return this.installPackage(bytes, { kind: 'vsix', label: url.origin + url.pathname }, confirm, options);
  }

  /**
   * Removes the extension from this tab and waits for its deactivation, then removes its record, its package
   * folder and its state. A failed record write registers the extension again; a failed folder removal is left
   * to the startup cleanup; a failed state removal is reported without registering the extension again. While the
   * list is session-only, folders in persistent files stay for the tabs and starts that still record them.
   */
  uninstall(identifier: string): Promise<boolean> {
    return this.serialize(() => this.remove(identifier));
  }

  private async remove(identifier: string): Promise<boolean> {
    const id = identifier.toLowerCase();
    const description = this.installed.find(extension => extension.identifier.value === id);
    if (!description || !this.active.removeExtension?.(id)) {
      return false;
    }
    await this.active.whenExtensionRemoved?.(id);
    let removedRecord = false;
    try {
      await this.scanner.locked(async (read, write) => {
        const installed = read();
        const record = installed.find(extension => extension.identifier === id);
        const remaining = installed.filter(extension => extension.identifier !== id);
        await write(remaining);
        removedRecord = true;
        if (record) {
          await this.removeUnreferenced(record.location, remaining);
        }
        await this.active.clearExtensionStorage?.(id);
      });
    } catch (error) {
      if (!removedRecord) {
        this.registerAgain(description);
      }
      throw error;
    }
    return true;
  }

  /** Registers an extension again after a failed change. A failure here is logged so the change's error is the one reported. */
  private registerAgain(description: IExtensionDescription): void {
    try {
      if (!this.active.addExtension?.(description)) {
        console.error(`Could not register '${description.identifier.value}' again.`);
      }
    } catch (error) {
      console.error(`Could not register '${description.identifier.value}' again.`, error);
    }
  }

  /**
   * Call while holding the installed-list lock, with the list just written. A session-only list says nothing about
   * persistent files, which other tabs and the next start still use, so it removes a folder only from session files.
   */
  private async removeUnreferenced(location: string, installed: readonly StoredWebExtension[]): Promise<void> {
    if (isExtensionPackageLocation(location) && !installed.some(extension => extension.location === location)) {
      try {
        if (this.scanner.sessionOnly && await this.packages.isPersistent()) {
          return;
        }
        await this.packages.remove(location);
      } catch (error) {
        console.warn(`Could not remove the extension package folder '${location}'. It is removed at a later start.`, error);
      }
    }
  }
}
