import { Disposable } from '../../base/common/lifecycle.js';
import type { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';

export class Memento<T extends object> extends Disposable {
  private readonly key: string;
  private readonly scopes = new Map<StorageScope, {
    readonly value: Partial<T>;
    readonly target: StorageTarget;
    lastSaved: string;
  }>();

  constructor(
    id: string,
    private readonly storageService: IStorageService,
    private readonly options: { readonly saveUnchanged?: boolean } = {},
  ) {
    super();
    this.key = 'memento/' + id;
    this._register(storageService.onWillSaveState(() => this.saveMemento()));
  }

  getMemento(scope: StorageScope, target: StorageTarget): Partial<T> {
    let entry = this.scopes.get(scope);
    if (!entry) {
      const stored = this.storageService.getObject<Partial<T>>(this.key, scope);
      if (Array.isArray(stored)) {
        console.warn('Invalid workbench memento.', { key: this.key, scope });
      }
      const value = stored && !Array.isArray(stored) ? stored : {};
      entry = { value, target, lastSaved: JSON.stringify(value) };
      this.scopes.set(scope, entry);
    }
    return entry.value;
  }

  saveMemento(): void {
    for (const [scope, entry] of this.scopes) {
      const text = JSON.stringify(entry.value);
      // Editors intentionally save their full session snapshot when this tab is hidden.
      // Other components leave unchanged snapshots alone because they may be stale.
      if (!this.options.saveUnchanged && text === entry.lastSaved) {
        continue;
      }
      if (text === '{}') {
        this.storageService.remove(this.key, scope);
      } else {
        this.storageService.store(this.key, text, scope, entry.target);
      }
      entry.lastSaved = text;
    }
  }
}
