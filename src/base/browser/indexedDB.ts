import type { IDisposable } from '../common/lifecycle.js';

/** One browser connection. Callbacks may await requests on this transaction. */
export class IndexedDB implements IDisposable {
  private closed = false;

  private constructor(private readonly database: IDBDatabase) {
    database.addEventListener('versionchange', () => this.dispose());
    database.addEventListener('close', () => { this.closed = true; });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  static open(name: string, version: number, stores: readonly string[], timeoutMs = 5_000): Promise<IndexedDB> {
    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(name, version);
      let failed = false;
      const fail = (error: unknown) => {
        failed = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error(`Opening database "${name}" timed out`)), timeoutMs);
      request.onblocked = () => fail(new Error(`Database "${name}" is blocked by another tab`));
      request.onerror = () => fail(request.error);
      request.onupgradeneeded = () => {
        if (failed) {
          request.transaction?.abort();
          return;
        }
        for (const store of stores) {
          if (!request.result.objectStoreNames.contains(store)) {
            request.result.createObjectStore(store);
          }
        }
      };
      request.onsuccess = () => {
        if (failed) {
          request.result.close();
          return;
        }
        if (stores.some(store => !request.result.objectStoreNames.contains(store))) {
          request.result.close();
          fail(new Error(`Database "${name}" is missing a required object store`));
          return;
        }
        clearTimeout(timeout);
        resolve(new IndexedDB(request.result));
      };
    });
  }

  async runInTransaction<T>(
    storeName: string, mode: 'readonly' | 'readwrite', run: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const transaction = this.database.transaction(storeName, mode);
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Database transaction aborted'));
    });
    const result = (async () => {
      try {
        return await run(transaction.objectStore(storeName));
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The request may already have aborted the transaction.
        }
        throw error;
      }
    })();

    try {
      const [value] = await Promise.all([result, completed]);
      return value;
    } catch (error) {
      await completed.catch(() => {});
      throw error;
    }
  }

  dispose(): void {
    this.closed = true;
    this.database.close();
  }
}

export function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function prefixEnd(prefix: string): string {
  // A directory prefix ends in '/'. The exclusive upper bound ends in '0'.
  return prefix.slice(0, -1) + '0';
}

export function idbStringPrefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, prefixEnd(prefix), true, true);
}

export function idbDirectoryKeys(store: IDBObjectStore, prefix: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const keys: string[] = [];
    const request = store.openKeyCursor(idbStringPrefixRange(prefix));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(keys);
        return;
      }
      const key = cursor.key as string;
      const slash = key.indexOf('/', prefix.length);
      if (slash !== -1) {
        const next = prefixEnd(key.slice(0, slash + 1));
        // Seeking skips the rest of this child's subtree in the backing index.
        if (next < prefixEnd(prefix)) {
          cursor.continue(next);
        } else {
          resolve(keys);
        }
        return;
      }
      keys.push(key);
      cursor.continue();
    };
  });
}
