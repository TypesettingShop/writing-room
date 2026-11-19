import type { IDisposable } from '../common/lifecycle.js';

/** One browser connection. Callbacks may await requests on this transaction. */
export class IndexedDB implements IDisposable {
  private constructor(private readonly database: IDBDatabase) {
    database.addEventListener('versionchange', () => this.dispose());
  }

  static open(name: string, version: number, stores: readonly string[]): Promise<IndexedDB> {
    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(name, version);
      let failure: unknown;
      const fail = (error: unknown) => {
        failure = error;
        reject(error);
      };
      request.onblocked = () => fail(new Error(`Database "${name}" is blocked by another tab`));
      request.onerror = () => fail(request.error);
      request.onupgradeneeded = () => {
        if (failure) {
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
        if (failure || stores.some(store => !request.result.objectStoreNames.contains(store))) {
          request.result.close();
          fail(failure ?? new Error(`Database "${name}" is missing a required object store`));
          return;
        }
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
    this.database.close();
  }
}

export function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function idbStringPrefixRange(prefix: string): IDBKeyRange {
  // Our callers supply a directory prefix ending in '/'. The exclusive upper bound ends in '0'.
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  return IDBKeyRange.bound(prefix, upper, true, true);
}
