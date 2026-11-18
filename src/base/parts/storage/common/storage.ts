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

  constructor(private database: IStorageDatabase) {
    try {
      this.items = database.getItems();
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
    this.database.close();
    this.database = new InMemoryStorageDatabase(this.items);
    this.pending.clear();
    console.warn('Workbench storage switched to memory.', error);
  }

  close(): void {
    this.flush();
    this.database.close();
  }
}
