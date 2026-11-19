export interface IStorageUpdate {
  readonly insert: ReadonlyMap<string, string>;
  readonly delete: ReadonlySet<string>;
}

export interface IStorageDatabase {
  /** Return a snapshot owned by the caller. */
  getItems(): Map<string, string>;
  updateItems(update: IStorageUpdate): void;
  close(): void;
}

export class InMemoryStorageDatabase implements IStorageDatabase {
  private readonly items: Map<string, string>;

  constructor(items?: ReadonlyMap<string, string>) {
    this.items = new Map(items);
  }

  getItems(): Map<string, string> {
    return new Map(this.items);
  }

  updateItems(update: IStorageUpdate): void {
    for (const key of update.delete) {
      this.items.delete(key);
    }
    for (const [key, value] of update.insert) {
      this.items.set(key, value);
    }
  }

  close(): void {}
}

export class Storage {
  private items = new Map<string, string>();
  private pending = new Map<string, string | undefined>();
  private scheduled = false;
  private database: IStorageDatabase;

  constructor(private readonly persistentDatabase: IStorageDatabase) {
    this.database = persistentDatabase;
    try {
      this.items = persistentDatabase.getItems();
    } catch (error) {
      this.useMemory(error);
    }
  }

  get(key: string): string | undefined {
    return this.items.get(key);
  }

  keys(): IterableIterator<string> {
    return this.items.keys();
  }

  set(key: string, value: string | undefined): boolean {
    if (!this.updateCache(key, value)) {
      return false;
    }
    this.pending.set(key, value);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.flush();
      });
    }
    return true;
  }

  /** Commit an explicit save before changing what readers see. A failed write remains retryable. */
  setImmediately(key: string, write: string | ((stored: string | undefined) => string)): boolean {
    const usingFallback = this.database !== this.persistentDatabase;
    try {
      // Reopen a backend closed by the fallback, for this write only. A transform also reads the current
      // persisted value, even when a different tab's storage event has yet to reach this cache.
      const stored = usingFallback || typeof write === 'function'
        ? this.persistentDatabase.getItems().get(key) : undefined;
      const value = typeof write === 'function' ? write(stored) : write;
      const update = { insert: new Map([[key, value]]), delete: new Set<string>() };
      this.persistentDatabase.updateItems(update);
      if (usingFallback) {
        this.database.updateItems(update);
      }
      this.pending.delete(key);
      return this.updateCache(key, value);
    } finally {
      if (usingFallback) {
        // The rest of this tab's state lives only in memory, so it keeps ignoring other tabs' writes.
        this.persistentDatabase.close();
      }
    }
  }

  acceptExternal(key: string, value: string | undefined): boolean {
    // A write queued in this tab will reach the database after the external write.
    return !this.pending.has(key) && this.updateCache(key, value);
  }

  private updateCache(key: string, value: string | undefined): boolean {
    if (this.items.get(key) === value) {
      return false;
    }
    if (value === undefined) {
      this.items.delete(key);
    } else {
      this.items.set(key, value);
    }
    return true;
  }

  flush(): void {
    if (!this.pending.size) {
      return;
    }
    const insert = new Map<string, string>();
    const deleted = new Set<string>();
    for (const [key, value] of this.pending) {
      if (value === undefined) {
        deleted.add(key);
      } else {
        insert.set(key, value);
      }
    }
    this.pending.clear();
    try {
      this.database.updateItems({ insert, delete: deleted });
    } catch (error) {
      this.useMemory(error);
    }
  }

  useMemory(error: unknown): void {
    this.closeDatabases();
    this.database = new InMemoryStorageDatabase(this.items);
    this.pending.clear();
    console.warn('Workbench storage switched to memory.', error);
  }

  close(): void {
    this.flush();
    this.closeDatabases();
  }

  private closeDatabases(): void {
    this.database.close();
    if (this.database !== this.persistentDatabase) {
      this.persistentDatabase.close();
    }
  }
}
