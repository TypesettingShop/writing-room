import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import type { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { isTextFileScheme } from './textfiles.js';

/** What a draft was based on, so a save after a reload still checks the file it was read from. */
export interface ITextFileBackupMeta {
  /** The etag of the file when its text was last read or saved, `undefined` when there was no file. */
  readonly etag: string | undefined;
  readonly bom: boolean;
}

export interface ITextFileBackup {
  readonly resource: URI;
  readonly value: string;
  readonly meta: ITextFileBackupMeta;
}

/** Where the drafts of dirty file models go. */
export interface ITextFileBackups {
  write(resource: URI, value: string, meta: ITextFileBackupMeta): Promise<void>;
  discard(resource: URI): Promise<void>;
  read(resource: URI): Promise<ITextFileBackup | undefined>;
}

/** Exclusive locks shared by pages that use the same storage. */
export interface IBackupLocks {
  /** Resolves when the lock has been acquired. The page holds it for its lifetime. */
  hold(name: string): Promise<void>;
  /** Runs the task with an exclusive lock only if it can be acquired without waiting. */
  runIfAvailable(name: string, task: () => Promise<void>): Promise<void>;
}

const BACKUP_FORMAT = 1;
const SESSION_ID = /^[0-9a-f]{32}$/;
const BACKUP_NAME = /^[0-9a-f]{16}$/;

interface IStoredBackup {
  readonly draft?: Omit<ITextFileBackup, 'value'> & { readonly bytes: Uint8Array };
}

/** A new ID for each page, including in contexts without `crypto.randomUUID`. */
export function createBackupSessionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A 64-bit FNV-1a hash of `value`'s UTF-16 code units, as 16 hex digits: the same name for the same resource. */
export function hashResource(value: string): string {
  // Two 32-bit halves of the 64-bit product, as JavaScript has no 64-bit integer arithmetic on numbers.
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let index = 0; index < value.length; index++) {
    low ^= value.charCodeAt(index);
    // Multiply by the FNV prime 0x100000001b3: (high, low) * (0x100, 0x1b3).
    const lowProduct = low * 0x1b3;
    const carry = Math.floor(lowProduct / 0x1_0000_0000);
    const newLow = lowProduct >>> 0;
    const newHigh = (Math.imul(high, 0x1b3) + Math.imul(low, 0x100) + carry) >>> 0;
    low = newLow;
    high = newHigh;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

/**
 * The drafts of this page, one file per resource under
 * `vscode-userdata:/User/workspaceStorage/<workspace id>/backups/<session id>/`.
 * At startup the page claims drafts from dead sessions by moving them into its own folder.
 */
export class TextFileBackups implements ITextFileBackups {
  readonly root: URI;
  private readonly session: URI;
  private readonly ready: Promise<void>;
  /** Writes, discards and transfers to each backup path run in order. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /**
   * Backup names of this session that this page wrote or moved in, with their resources. Only this
   * page puts files in its folder, so these need no header check before a write or discard.
   */
  private readonly owned = new Map<string, string>();
  /** A listed draft that could not be read stays in its former session for the next startup. */
  private readonly failedAdoptionReads = new Map<string, unknown>();

  constructor(
    private readonly fileService: IFileService,
    workspaceId: string,
    private readonly sessionId: string,
    private readonly locks: IBackupLocks | undefined = createBackupLocks(),
  ) {
    if (!SESSION_ID.test(sessionId)) {
      throw new Error('Invalid draft backup session ID.');
    }
    this.root = URI.from({ scheme: 'vscode-userdata', path: `/User/workspaceStorage/${encodeURIComponent(workspaceId)}/backups` });
    this.session = joinPath(this.root, sessionId);
    this.ready = this.adoptBackups().catch(error => console.warn('Could not claim draft backups at startup.', error));
  }

  backupResource(resource: URI): URI {
    return joinPath(this.session, hashResource(resource.toString()));
  }

  async write(resource: URI, value: string, meta: ITextFileBackupMeta): Promise<void> {
    await this.ready;
    const location = this.backupResource(resource);
    const key = hashResource(resource.toString());
    const header = JSON.stringify({ version: BACKUP_FORMAT, resource: resource.toString(), etag: meta.etag ?? null, bom: meta.bom });
    return this.queue(resource, async () => {
      if (this.owned.get(key) !== resource.toString()) {
        const stored = await this.readBackup(location);
        if (stored && stored.draft?.resource.toString() !== resource.toString()) {
          throw new Error(`Cannot replace the existing draft backup ${location}.`);
        }
      }
      await this.fileService.writeFile(location, new TextEncoder().encode(header + '\n' + value));
      this.owned.set(key, resource.toString());
    });
  }

  async discard(resource: URI): Promise<void> {
    await this.ready;
    return this.queue(resource, async () => {
      const location = this.backupResource(resource);
      const key = hashResource(resource.toString());
      if (this.owned.get(key) === resource.toString()
        || (await this.readBackup(location))?.draft?.resource.toString() === resource.toString()) {
        await this.deleteBackup(location);
        this.owned.delete(key);
      }
    });
  }

  /** Active editors can resolve before the startup contribution, so reads wait for adoption here. */
  async read(resource: URI): Promise<ITextFileBackup | undefined> {
    await this.ready;
    const key = hashResource(resource.toString());
    await this.queues.get(key);
    const draft = (await this.readBackup(this.backupResource(resource)))?.draft;
    if (draft?.resource.toString() !== resource.toString()) {
      if (this.failedAdoptionReads.has(key)) {
        throw this.failedAdoptionReads.get(key);
      }
      return undefined;
    }
    return {
      resource: draft.resource,
      meta: draft.meta,
      value: new TextDecoder('utf-8', { ignoreBOM: true }).decode(draft.bytes),
    };
  }

  /** Lists the drafts this page can restore, including drafts without a saved editor. */
  async listRestorable(): Promise<URI[]> {
    await this.ready;
    const resources: URI[] = [];
    for (const child of await this.children(this.session)) {
      if (child.isFile) {
        await this.tryRestore(child.resource, async () => {
          const draft = (await this.readBackup(child.resource))?.draft;
          if (draft) {
            resources.push(draft.resource);
          }
        });
      }
    }
    return resources;
  }

  /** Rechecks a resource from the startup list after any queued write or discard. */
  async hasRestorable(resource: URI): Promise<boolean> {
    await this.ready;
    const key = hashResource(resource.toString());
    await this.queues.get(key);
    const location = this.backupResource(resource);
    if (this.owned.get(key) === resource.toString()) {
      return this.fileService.exists(location);
    }
    return (await this.readBackup(location))?.draft?.resource.toString() === resource.toString();
  }

  private sessionLockName(id: string): string {
    return `writing-room/backupSession${this.root.path}/${id}`;
  }

  private async adoptBackups(): Promise<void> {
    try {
      await this.locks?.hold(this.sessionLockName(this.sessionId));
    } catch (error) {
      // A denied lock leaves this page writing only to its own session folder.
      console.warn('Could not lock this draft session. Draft adoption is disabled for this page.', error);
      return;
    }
    const claims: { readonly written: number; readonly run: () => Promise<void> }[] = [];
    for (const child of await this.children(this.root)) {
      if (child.isDirectory && child.name !== this.sessionId && SESSION_ID.test(child.name)) {
        claims.push({
          written: await this.lastWritten(child.resource),
          run: () => this.claim(child.resource, this.sessionLockName(child.name), async () => {
            for (const entry of await this.children(child.resource)) {
              if (entry.isFile) {
                await this.tryRestore(entry.resource, () => this.adoptDraft(entry));
              }
            }
            if ((await this.children(child.resource)).length === 0) {
              // A non-recursive delete also checks emptiness at the provider in case the folder gained a file.
              await this.deleteBackup(child.resource);
            }
          }),
        });
      } else if (child.isFile) {
        if (!BACKUP_NAME.test(child.name)) {
          console.warn(`Invalid draft backup name ${child.resource}.`);
          continue;
        }
        // Older pages hold a shared lock per file under the original name.
        claims.push({
          written: child.mtime,
          run: () => this.claim(child.resource, `writing-room/backup${this.root.path}/${child.name}`, () => this.adoptDraft(child)),
        });
      }
    }
    // Try the most recently written sessions and legacy files first. A session's time is the
    // latest write among its drafts, so a reload gives priority to the session just edited.
    claims.sort((a, b) => b.written - a.written);
    for (const claim of claims) {
      await claim.run();
    }
  }

  /** When a session folder's drafts were last written. Reading the listing needs no lock. */
  private async lastWritten(folder: URI): Promise<number> {
    try {
      return (await this.children(folder)).reduce((latest, entry) => entry.isFile ? Math.max(latest, entry.mtime) : latest, 0);
    } catch {
      // The claim reads the folder again and reports what fails.
      return 0;
    }
  }

  private claim(source: URI, name: string, task: () => Promise<void>): Promise<void> {
    return this.tryRestore(source, () => this.locks ? this.locks.runIfAvailable(name, task) : task());
  }

  private async adoptDraft(entry: IFileStat): Promise<void> {
    const stored = await this.readBackup(entry.resource).catch(error => {
      this.failedAdoptionReads.set(entry.name, error);
      throw error;
    });
    const draft = stored?.draft;
    if (!draft) {
      return;
    }
    const resource = draft.resource;
    // Only one draft per resource fits in this page. The provider moves it in one transaction.
    await this.queue(resource, async () => {
      try {
        await this.fileService.move(entry.resource, this.backupResource(resource));
        this.owned.set(hashResource(resource.toString()), resource.toString());
      } catch (error) {
        const code = toFileSystemProviderErrorCode(error);
        if (code !== FileSystemProviderErrorCode.FileNotFound && code !== FileSystemProviderErrorCode.FileExists) {
          throw error;
        }
      }
    });
  }

  private async tryRestore(location: URI, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      console.warn(`Could not restore draft backup at ${location}.`, error);
    }
  }

  private async children(location: URI): Promise<readonly IFileStat[]> {
    try {
      return (await this.fileService.resolve(location)).children ?? [];
    } catch (error) {
      if (toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound) {
        return [];
      }
      throw error;
    }
  }

  private queue(resource: URI, task: () => Promise<void>): Promise<void> {
    const key = hashResource(resource.toString());
    const next = (this.queues.get(key) ?? Promise.resolve()).then(task, task);
    const settled = next.catch(() => {});
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) {
        this.queues.delete(key);
      }
    });
    return next;
  }

  private async deleteBackup(location: URI): Promise<void> {
    try {
      await this.fileService.del(location);
    } catch (error) {
      if (toFileSystemProviderErrorCode(error) !== FileSystemProviderErrorCode.FileNotFound) {
        throw error;
      }
    }
  }

  private async readBackup(location: URI): Promise<IStoredBackup | undefined> {
    const name = basename(location);
    if (!BACKUP_NAME.test(name)) {
      console.warn(`Invalid draft backup name ${location}.`);
      return {};
    }
    let bytes: Uint8Array;
    try {
      bytes = (await this.fileService.readFile(location)).value;
    } catch (error) {
      if (toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound) {
        return undefined;
      }
      throw error;
    }
    const newline = bytes.indexOf(10);
    try {
      const header: unknown = newline < 0 ? undefined
        : JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, newline)));
      if (typeof header === 'object' && header !== null) {
        const { version, resource, etag, bom } = header as Record<string, unknown>;
        if (typeof version === 'number' && version > BACKUP_FORMAT) {
          return {};
        }
        if (version === BACKUP_FORMAT && typeof resource === 'string'
          && (etag === null || typeof etag === 'string') && typeof bom === 'boolean') {
          const uri = URI.parse(resource, true);
          if (isTextFileScheme(uri.scheme) && hashResource(uri.toString()) === name) {
            return { draft: { resource: uri, bytes: bytes.subarray(newline + 1), meta: { etag: etag ?? undefined, bom } } };
          }
        }
      }
    } catch {
      // The draft stays on disk even if its header cannot be read.
    }
    console.warn(`Invalid draft backup ${location}.`);
    return {};
  }
}

/** The browser releases a page's session lock when that page goes away. */
function createBackupLocks(): IBackupLocks | undefined {
  const manager = globalThis.navigator?.locks;
  if (!manager) {
    return undefined;
  }
  return {
    hold(name) {
      return new Promise<void>((resolve, reject) => {
        void manager.request(name, { mode: 'exclusive' }, () => {
          resolve();
          return new Promise<void>(() => {});
        }).catch(reject);
      });
    },
    async runIfAvailable(name, task) {
      await manager.request(name, { mode: 'exclusive', ifAvailable: true }, lock => lock ? task() : undefined);
    },
  };
}
