import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { galleryId, GalleryRateLimitError, IExtensionGalleryService } from '../../../../platform/extensionManagement/common/extensionGalleryService.js';
import type { ExtensionGalleryService, GalleryExtension, GalleryIdentifier } from '../../../../platform/extensionManagement/common/extensionGalleryService.js';
import { vsixLimits } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IExtensionManagementService, IWebExtensionsScannerService, localizedDisplayName, isExtensionPackageLocation } from '../../../services/extensionManagement/common/extensionManagementService.js';
import type { ExtensionManagementService, ExtensionSource, PackageInstallConfirmation } from '../../../services/extensionManagement/common/extensionManagementService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { confirmPackage } from './extensionInstallConfirmation.js';

export const IExtensionsWorkbenchService = createDecorator<ExtensionsWorkbenchService>('extensionsWorkbenchService');

const installLimit = 2;
const dependencyDepthLimit = 3;

type InstallJob = { readonly controller: AbortController };
type Operation = { readonly kind: 'installing'; readonly job: InstallJob; readonly text: string; readonly cancellable: boolean }
  | { readonly kind: 'removing' };
type FailedOperation = { readonly message: string; readonly requiresInstallSlot: boolean; readonly retry: () => void };
type SearchStatus = 'idle' | 'searching' | 'complete' | 'error';

export interface InstalledExtension {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly source: ExtensionSource | 'builtin';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** SemVer precedence. Numeric identifiers compare by digit count first, so large identifiers stay exact. */
function compareVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const [core, prerelease] = version.split('+')[0].split(/-(.*)/);
    return { core: core.split('.'), prerelease: prerelease?.split('.') };
  };
  const compare = (a: string, b: string): number => {
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    }
    return (aNumeric ? a.length - b.length : 0) || (a < b ? -1 : a > b ? 1 : 0);
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    const order = compare(a.core[i], b.core[i]);
    if (order) {
      return order;
    }
  }
  if (!a.prerelease || !b.prerelease) {
    return Number(!a.prerelease) - Number(!b.prerelease);
  }
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const order = compare(a.prerelease[i], b.prerelease[i]);
    if (order) {
      return order;
    }
  }
  return a.prerelease.length - b.prerelease.length;
}

export async function installVsixFile(
  management: ExtensionManagementService, file: File, confirm: (confirmation: PackageInstallConfirmation) => Promise<boolean>,
): Promise<void> {
  if (file.size > vsixLimits.download) {
    throw new Error(`'${file.name}' is ${file.size} bytes, more than the ${vsixLimits.download}-byte limit.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await management.installPackage(bytes, { kind: 'vsix', label: file.name }, confirm);
}

/** Holds search and per-extension operations across view moves and focus changes. */
export class ExtensionsWorkbenchService extends Disposable {
  declare readonly _serviceBrand: undefined;
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;

  private readonly operations = new Map<string, Operation>();
  private readonly errors = new Map<string, FailedOperation>();
  private readonly jobs = new Set<InstallJob>();
  private confirmTail = Promise.resolve<unknown>(undefined);
  private searchController?: AbortController;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private currentQuery = '';
  private searchStatus: SearchStatus = 'idle';
  private results: readonly GalleryExtension[] = [];
  private nextOffset?: number;
  private searchError?: string;
  private failedOffset = 0;

  constructor(
    @IExtensionGalleryService private readonly gallery: ExtensionGalleryService,
    @IExtensionManagementService private readonly management: ExtensionManagementService,
    @IWebExtensionsScannerService private readonly scanner: IWebExtensionsScannerService,
    @IExtensionService private readonly extensions: IExtensionService,
    @IQuickInputService private readonly quickInput: IQuickInputService,
  ) {
    super();
    if (extensions.onDidChangeExtensions) {
      this._register(extensions.onDidChangeExtensions(() => this.changed.fire()));
    }
    void extensions.whenInstalledExtensionsRegistered().then(() => this.changed.fire());
  }

  get galleryEnabled(): boolean { return this.gallery.enabled; }
  get galleryLimitMessage(): string | undefined { return this.gallery.rateLimited ? new GalleryRateLimitError().message : undefined; }
  get query(): string { return this.currentQuery; }
  get status(): SearchStatus { return this.searchStatus; }
  get searchResults(): readonly GalleryExtension[] { return this.results; }
  get hasMore(): boolean { return this.nextOffset !== undefined; }
  get searchFailure(): string | undefined { return this.searchError; }
  get canStartInstall(): boolean { return this.jobs.size < installLimit; }

  get installed(): readonly InstalledExtension[] {
    const records = new Map(this.scanner.scanUserExtensions().map(record => [record.identifier, record]));
    return (this.extensions.extensions ?? []).map(({ identifier, manifest, location, nls, isBuiltin }) => ({
      id: identifier.value, displayName: localizedDisplayName(manifest, nls), version: manifest.version,
      source: isBuiltin ? 'builtin' : records.get(identifier.value)?.source ?? (isExtensionPackageLocation(location) ? 'vsix' : 'location'),
    } satisfies InstalledExtension)).sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  operation(id: string): Operation | undefined { return this.operations.get(id); }
  failure(id: string): FailedOperation | undefined { return this.errors.get(id); }

  canUpdate(result: GalleryExtension, installed: InstalledExtension): boolean {
    return installed.source !== 'builtin' && compareVersions(result.version, installed.version) > 0;
  }

  search(query: string): void {
    this.currentQuery = query;
    this.results = [];
    this.nextOffset = undefined;
    if (query.trim() && this.gallery.enabled) {
      this.startSearch(0, 300);
    } else {
      this.clearSearch();
      this.searchError = undefined;
      this.searchStatus = 'idle';
      this.changed.fire();
    }
  }

  searchMore(): void {
    if (this.nextOffset !== undefined && this.searchStatus === 'complete') {
      this.startSearch(this.nextOffset, 0);
    }
  }

  retrySearch(): void {
    if (this.searchStatus === 'error') {
      this.startSearch(this.failedOffset, 0);
    }
  }

  fetchIcon(url: string, signal: AbortSignal): Promise<Blob> {
    return this.gallery.fetchIcon(url, signal);
  }

  private clearSearch(): void {
    clearTimeout(this.searchTimer);
    this.searchController?.abort();
    this.searchController = undefined;
  }

  private startSearch(offset: number, delay: number): void {
    this.clearSearch();
    const controller = new AbortController();
    const query = this.currentQuery;
    this.searchController = controller;
    this.searchStatus = 'searching';
    this.searchError = undefined;
    this.changed.fire();
    this.searchTimer = setTimeout(() => {
      void this.performSearch(query, offset, controller);
    }, delay);
  }

  private async performSearch(query: string, offset: number, controller: AbortController): Promise<void> {
    try {
      const page = await this.gallery.search(query, offset, controller.signal);
      if (this.searchController !== controller) {
        return;
      }
      const extensions = new Map(this.results.map(result => [result.id, result]));
      for (const result of page.extensions) {
        if (!extensions.has(result.id)) {
          extensions.set(result.id, result);
        }
      }
      this.results = [...extensions.values()];
      this.nextOffset = page.nextOffset;
      this.searchStatus = 'complete';
    } catch (error) {
      if (this.searchController !== controller) {
        return;
      }
      this.searchStatus = 'error';
      this.failedOffset = offset;
      this.searchError = errorMessage(error);
    }
    this.changed.fire();
  }

  install(result: GalleryExtension): void {
    if (this.operations.has(result.id) || !this.canStartInstall) {
      return;
    }
    const installed = this.installed.find(extension => extension.id === result.id);
    if (installed && !this.canUpdate(result, installed)) {
      return;
    }
    const job = { controller: new AbortController() };
    this.jobs.add(job);
    this.errors.delete(result.id);
    void this.installRoot(result, job);
  }

  cancel(id: string): void {
    const operation = this.operations.get(id);
    if (operation?.kind === 'installing' && operation.cancellable) {
      operation.job.controller.abort();
    }
  }

  private async installRoot(result: GalleryExtension, job: InstallJob): Promise<void> {
    const id = result.id;
    try {
      await this.installRelease(result, result.version, job, []);
    } catch (error) {
      if (!job.controller.signal.aborted) {
        this.errors.set(id, { message: errorMessage(error), requiresInstallSlot: true, retry: () => this.install(result) });
      }
    } finally {
      this.jobs.delete(job);
      this.changed.fire();
    }
  }

  private async installRelease(identifier: GalleryIdentifier, version: string | undefined, job: InstallJob,
    ancestors: readonly string[]): Promise<boolean> {
    const id = galleryId(identifier);
    if (ancestors.includes(id)) {
      throw new Error('Open VSX dependency cycle: ' + [...ancestors, id].join(' → '));
    }
    if (ancestors.length > dependencyDepthLimit) {
      throw new Error('Open VSX extension dependencies are nested more than three levels deep.');
    }
    if (ancestors.length && this.installed.some(extension => extension.id === id) && !this.operations.has(id)) {
      return true;
    }
    if (this.operations.has(id)) {
      throw new Error(`'${id}' has another operation in progress. Try again when it finishes.`);
    }
    const { signal } = job.controller;
    signal.throwIfAborted();
    this.setInstalling(id, job, 'Getting version information…');
    try {
      const metadata = await this.gallery.getExtension(identifier, version, signal);
      this.setInstalling(id, job, 'Downloading and verifying…');
      const download = await this.gallery.download(metadata, signal);
      const result = await this.management.installFromGallery(metadata, download, async confirmation => {
        this.setInstalling(id, job, 'Waiting for confirmation…');
        if (!await this.confirm(confirmation, signal)) {
          return false;
        }
        if (metadata.dependencies.length) {
          this.setInstalling(id, job, 'Installing dependencies…');
          for (const dependency of metadata.dependencies) {
            if (!await this.installRelease(dependency, undefined, job, [...ancestors, id])) {
              return false;
            }
          }
        }
        signal.throwIfAborted();
        this.setInstalling(id, job, 'Installing…', false);
        return true;
      }, { signal });
      return result !== undefined;
    } finally {
      this.operations.delete(id);
      this.changed.fire();
    }
  }

  private setInstalling(id: string, job: InstallJob, text: string, cancellable = true): void {
    this.operations.set(id, { kind: 'installing', job, text, cancellable });
    this.changed.fire();
  }

  private confirm(confirmation: PackageInstallConfirmation, signal?: AbortSignal): Promise<boolean> {
    // There is one workbench QuickPick. Independent downloads can finish together.
    const answer = this.confirmTail.then(() => confirmPackage(this.quickInput, confirmation, signal));
    this.confirmTail = answer.catch(() => {});
    return answer;
  }

  uninstall(extension: InstalledExtension): void {
    if (extension.source === 'builtin' || this.operations.has(extension.id)) {
      return;
    }
    this.operations.set(extension.id, { kind: 'removing' });
    this.errors.delete(extension.id);
    this.changed.fire();
    void this.management.uninstall(extension.id).catch(error => {
      this.errors.set(extension.id, { message: errorMessage(error), requiresInstallSlot: false, retry: () => this.uninstall(extension) });
    }).finally(() => {
      this.operations.delete(extension.id);
      this.changed.fire();
    });
  }

  installDroppedFile(file: File): Promise<void> {
    return installVsixFile(this.management, file, confirmation => this.confirm(confirmation));
  }

  override dispose(): void {
    this.clearSearch();
    for (const { controller } of this.jobs) {
      controller.abort();
    }
    super.dispose();
  }
}
