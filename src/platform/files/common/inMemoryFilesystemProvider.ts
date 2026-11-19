import { StoredFileSystemProvider } from './storedFileSystemProvider.js';
import type { FileTreeStore, FileTreeTransactionMode, StoredEntry } from './storedFileSystemProvider.js';

export class InMemoryFileSystemProvider extends StoredFileSystemProvider {
  private readonly tree = new InMemoryFileTree();

  protected override transaction<T>(mode: FileTreeTransactionMode, run: (store: FileTreeStore) => Promise<T>): Promise<T> {
    return this.tree.transaction(mode, run);
  }
}

export class InMemoryFileTree {
  private readonly entries = new Map<string, StoredEntry>();
  private pending: Promise<unknown> = Promise.resolve();

  transaction<T>(mode: FileTreeTransactionMode, run: (store: FileTreeStore) => Promise<T>): Promise<T> {
    const operation = this.pending.then(async () => {
      const updates = new Map<string, StoredEntry | undefined>();
      const store: FileTreeStore = {
        get: async path => updates.has(path) ? updates.get(path) : this.entries.get(path),
        keys: async (prefix, immediate) => {
          const keys = new Set([...this.entries.keys(), ...updates.keys()]);
          return [...keys].filter(key => key !== prefix && key.startsWith(prefix)
            && (!immediate || !key.includes('/', prefix.length))
            && (!updates.has(key) || updates.get(key) !== undefined));
        },
        set: async (path, entry) => { updates.set(path, entry); },
        delete: async path => { updates.set(path, undefined); },
      };
      const result = await run(store);
      if (mode === 'readwrite') {
        for (const [path, entry] of updates) {
          if (entry) {
            this.entries.set(path, entry);
          } else {
            this.entries.delete(path);
          }
        }
      }
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
