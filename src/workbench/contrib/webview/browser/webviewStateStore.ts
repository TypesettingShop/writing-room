import { DeferredPromise } from '../../../../base/common/async.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, storageKey, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { userExtensionsKey } from '../../../services/extensionManagement/browser/webExtensionsScannerService.js';

const key = 'webview.states.v1';
const installedAddress = storageKey(StorageScope.PROFILE, userExtensionsKey);
const individualLimit = 256 * 1024;
const totalLimit = 1024 * 1024;
const utf8 = new TextEncoder();
const unchanged = Symbol('unchanged Webview state');

function panelLockName(id: string, extension: string): string {
  return 'writing-room:webview.panel:' + JSON.stringify([extension, id]);
}

interface StoredWebviewState {
  readonly id: string;
  readonly extension: string;
  readonly state: string;
}

interface ClosedPanel {
  readonly id: string;
  readonly extension: string;
  checking: boolean;
}

export const IWebviewStateStore = createDecorator<IWebviewStateStore>('webviewStateStore');

export interface IWebviewStateStore extends BrandedService {
  trackOpenPanel(id: string, extension: string): IDisposable;
  deferClosedPanelCleanup(id: string, extension: string): void;
  get(id: string, extension: string): string | undefined;
  set(id: string, extension: string, state: string): void;
  delete(id: string, extension: string): void;
  removeMissingExtensions(registered: ReadonlySet<string>): void;
}

function fits(text: string, limit: number): boolean {
  return text.length <= limit && utf8.encode(text).byteLength <= limit;
}

export function isWebviewState(value: unknown): value is string {
  if (typeof value !== 'string' || !fits(value, individualLimit)) {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function parseStates(raw: string | undefined): StoredWebviewState[] {
  if (!raw || !fits(raw, totalLimit)) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) {
      return value.filter(entry => entry && typeof entry.id === 'string' && entry.id.length <= 512
        && typeof entry.extension === 'string' && entry.extension.length <= 256 && isWebviewState(entry.state));
    }
  } catch {
    // The editor layout can still be restored when this separate state is unreadable.
  }
  return [];
}

/** An unreadable list cannot authorize removal. Keep every identifier the records name. */
function recordedIdentifiers(raw: string | undefined): ReadonlySet<string> | undefined {
  if (raw === undefined) {
    return new Set();
  }
  try {
    const records: unknown = JSON.parse(raw);
    if (Array.isArray(records)) {
      return new Set(records.flatMap(record =>
        isRecord(record) && typeof record.identifier === 'string' ? [record.identifier.toLowerCase()] : []));
    }
  } catch {
    // Leave all state in place until the installed list can be read.
  }
  return undefined;
}

export class WebviewStateStore implements IWebviewStateStore {
  declare readonly _serviceBrand: undefined;
  private readonly openPanels = new Map<string, number>();
  private readonly closedPanels = new Map<string, ClosedPanel>();
  private registered: ReadonlySet<string> = new Set();
  private warnedAboutLimit = false;
  private warnedAboutWrite = false;

  constructor(@IStorageService private readonly storage: IStorageService) {}

  trackOpenPanel(id: string, extension: string): IDisposable {
    const name = panelLockName(id, extension);
    this.openPanels.set(name, (this.openPanels.get(name) ?? 0) + 1);
    const released = new DeferredPromise<void>();
    const locks = this.storage.usesMemory ? undefined : globalThis.navigator?.locks;
    // Hidden and restored inputs hold the same lease as the visible panel, even before a serializer runs.
    const lease = locks?.request(name, { mode: 'shared' }, () => released.p).catch(() => {});
    const forget = () => {
      const count = this.openPanels.get(name) ?? 0;
      if (count > 1) {
        this.openPanels.set(name, count - 1);
      } else {
        this.openPanels.delete(name);
        if (this.closedPanels.has(name)) {
          this.pruneClosedPanels();
        }
      }
    };
    return toDisposable(() => {
      void released.complete();
      if (lease) {
        void lease.then(forget);
      } else {
        forget();
      }
    });
  }

  deferClosedPanelCleanup(id: string, extension: string): void {
    if (this.get(id, extension) !== undefined) {
      this.closedPanels.set(panelLockName(id, extension), { id, extension, checking: false });
    }
  }

  get(id: string, extension: string): string | undefined {
    return parseStates(this.storage.get(key, StorageScope.WORKSPACE))
      .find(entry => entry.id === id && entry.extension === extension)?.state;
  }

  set(id: string, extension: string, state: string): void {
    if (!isWebviewState(state)) {
      this.warnAboutLimit();
      return;
    }
    this.update(entries => [...entries.filter(entry => entry.id !== id || entry.extension !== extension),
      { id, extension, state }]);
  }

  delete(id: string, extension: string): void {
    if (this.update(entries => entries.filter(entry => entry.id !== id || entry.extension !== extension), true)) {
      this.closedPanels.delete(panelLockName(id, extension));
    }
  }

  removeMissingExtensions(registered: ReadonlySet<string>): void {
    this.registered = registered;
    const owned = (entries: StoredWebviewState[], recorded: ReadonlySet<string> | undefined) =>
      recorded && entries.filter(entry => {
        const identifier = entry.extension.toLowerCase();
        return registered.has(identifier) || recorded.has(identifier);
      });
    // Every tab prunes whenever any tab writes the installed list. Writing back the value it read with nothing
    // removed could put this tab's copy over a newer state from another tab, so nothing is written unless this
    // tab sees an entry to remove. Which entries go is still decided against the persisted list.
    const cached = parseStates(this.storage.get(key, StorageScope.WORKSPACE));
    const kept = owned(cached, recordedIdentifiers(this.storage.get(userExtensionsKey, StorageScope.PROFILE)));
    if (kept && kept.length !== cached.length) {
      this.update((entries, snapshot) => owned(entries, recordedIdentifiers(snapshot
        ? snapshot.get(installedAddress)
        : this.storage.get(userExtensionsKey, StorageScope.PROFILE))), true);
    }
    this.pruneClosedPanels();
  }

  private pruneClosedPanels(): void {
    if (!this.closedPanels.size) {
      return;
    }
    const cached = parseStates(this.storage.get(key, StorageScope.WORKSPACE));
    const saved = new Set(cached.map(entry => panelLockName(entry.id, entry.extension)));
    for (const [name, panel] of this.closedPanels) {
      if (!saved.has(name)) {
        this.closedPanels.delete(name);
        continue;
      }
      if (!this.registered.has(panel.extension) || this.openPanels.has(name) || panel.checking) {
        continue;
      }
      const remove = () => {
        // The owner or panel may have changed while the browser granted the lock.
        if (this.closedPanels.get(name) === panel && this.registered.has(panel.extension) && !this.openPanels.has(name)) {
          this.delete(panel.id, panel.extension);
        }
      };
      if (this.storage.usesMemory) {
        remove();
      } else {
        const locks = globalThis.navigator?.locks;
        // Without an exclusive lease, another tab may be displaying or restoring this exact panel.
        if (locks) {
          panel.checking = true;
          void locks.request(name, { ifAvailable: true }, lock => {
            if (lock) {
              remove();
            }
          }).catch(() => {}).finally(() => { panel.checking = false; });
        }
      }
    }
  }

  private update(
    change: (entries: StoredWebviewState[], snapshot?: ReadonlyMap<string, string>) => StoredWebviewState[] | undefined,
    allowMissing = false,
  ): boolean {
    const memory = this.storage.usesMemory;
    const cached = this.storage.get(key, StorageScope.WORKSPACE);
    if (allowMissing && cached === undefined) {
      return true;
    }
    const transform = (raw: string | undefined, snapshot?: ReadonlyMap<string, string>): string | undefined => {
      const entries = parseStates(raw);
      const updated = change(entries, snapshot);
      if (!updated || (allowMissing && updated.length === entries.length)) {
        return raw;
      }
      const encoded = JSON.stringify(updated);
      if (!fits(encoded, totalLimit)) {
        this.warnAboutLimit();
        return raw ?? '[]';
      }
      return encoded;
    };
    if (memory) {
      const updated = transform(cached);
      if (updated !== cached) {
        this.storage.store(key, updated, StorageScope.WORKSPACE, StorageTarget.MACHINE);
      }
      return true;
    }
    try {
      this.storage.storeImmediately(key, (raw, snapshot) => {
        const updated = transform(raw, snapshot);
        // Returning the old value would still write it and could overwrite a newer value from another tab.
        if (allowMissing && updated === raw) {
          throw unchanged;
        }
        return updated;
      }, StorageScope.WORKSPACE, StorageTarget.MACHINE);
      return true;
    } catch (error) {
      if (error === unchanged) {
        return true;
      }
      if (!this.warnedAboutWrite) {
        this.warnedAboutWrite = true;
        console.warn('Webview state could not be saved.', error);
      }
      return false;
    }
  }

  private warnAboutLimit(): void {
    if (!this.warnedAboutLimit) {
      this.warnedAboutLimit = true;
      console.warn('Webview state could not be saved. The limits are 256 KiB per webview and 1 MiB per workspace.');
    }
  }
}

registerSingleton(IWebviewStateStore, WebviewStateStore);
