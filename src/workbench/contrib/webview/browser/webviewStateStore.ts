import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

const key = 'webview.states.v1';
const individualLimit = 256 * 1024;
const totalLimit = 1024 * 1024;
const utf8 = new TextEncoder();

interface StoredWebviewState {
  readonly id: string;
  readonly extension: string;
  readonly state: string;
}

export const IWebviewStateStore = createDecorator<IWebviewStateStore>('webviewStateStore');

export interface IWebviewStateStore extends BrandedService {
  get(id: string, extension: string): string | undefined;
  set(id: string, extension: string, state: string): void;
  delete(id: string, extension: string): void;
  removeMissingExtensions(installed: ReadonlySet<string>): void;
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

export class WebviewStateStore implements IWebviewStateStore {
  declare readonly _serviceBrand: undefined;
  private warnedAboutLimit = false;
  private warnedAboutWrite = false;

  constructor(@IStorageService private readonly storage: IStorageService) {}

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
    this.update(entries => entries.filter(entry => entry.id !== id || entry.extension !== extension), true);
  }

  removeMissingExtensions(installed: ReadonlySet<string>): void {
    this.update(entries => entries.filter(entry => installed.has(entry.extension)), true);
  }

  private update(change: (entries: StoredWebviewState[]) => StoredWebviewState[], allowMissing = false): void {
    const memory = this.storage.usesMemory;
    const cached = this.storage.get(key, StorageScope.WORKSPACE);
    if (allowMissing && cached === undefined) {
      return;
    }
    const transform = (raw: string | undefined): string => {
      const entries = parseStates(raw);
      const updated = change(entries);
      if (allowMissing && updated.length === entries.length && raw) {
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
      return;
    }
    try {
      this.storage.storeImmediately(key, transform, StorageScope.WORKSPACE, StorageTarget.MACHINE);
    } catch (error) {
      if (!this.warnedAboutWrite) {
        this.warnedAboutWrite = true;
        console.warn('Webview state could not be saved.', error);
      }
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
