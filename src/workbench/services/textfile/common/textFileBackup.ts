import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import type { IFileService } from '../../../../platform/files/common/files.js';

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

/**
 * Lets other tabs of the same storage see which backups are still in use. A tab holds one lock per
 * draft it keeps; startup leaves the drafts of a live tab alone.
 */
export interface IBackupLocks {
  hold(name: string): void;
  release(name: string): void;
  /** The names held by any tab, this one included; `undefined` when nothing can tell. */
  held(): Promise<ReadonlySet<string> | undefined>;
  /** The names this tab holds. */
  readonly own: ReadonlySet<string>;
}

const BACKUP_FORMAT = 1;

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
 * The drafts of dirty file models, one file per resource under
 * `vscode-userdata:/User/workspaceStorage/<workspace id>/backups/`. A backup holds a header line with
 * the resource and what its text was based on, then the text.
 */
export class TextFileBackups implements ITextFileBackups {
  readonly root: URI;
  /** The writes and deletions of each backup, in the order asked: a discard after a write wins. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly fileService: IFileService,
    workspaceId: string,
    private readonly locks: IBackupLocks | undefined = createBackupLocks(),
  ) {
    this.root = URI.from({ scheme: 'vscode-userdata', path: `/User/workspaceStorage/${encodeURIComponent(workspaceId)}/backups` });
  }

  backupResource(resource: URI): URI {
    return joinPath(this.root, hashResource(resource.toString()));
  }

  private lockName(resource: URI): string {
    return `writing-room/backup${this.root.path}/${hashResource(resource.toString())}`;
  }

  /** Writes the draft of `resource`; the lock tells other tabs it is in use. */
  write(resource: URI, value: string, meta: ITextFileBackupMeta): Promise<void> {
    const name = this.lockName(resource);
    const header = JSON.stringify({ version: BACKUP_FORMAT, resource: resource.toString(), etag: meta.etag ?? null, bom: meta.bom });
    const bytes = new TextEncoder().encode(header + '\n' + value);
    // Held in turn with the writes and discards: a discard queued before this write releases the
    // lock when it runs, so taking it now would leave this write's backup without one.
    return this.queue(resource, async () => {
      this.locks?.hold(name);
      await this.fileService.writeFile(this.backupResource(resource), bytes);
    });
  }

  /** Forgets the draft of `resource`. */
  discard(resource: URI): Promise<void> {
    const name = this.lockName(resource);
    return this.queue(resource, async () => {
      await this.deleteBackup(this.backupResource(resource));
      this.locks?.release(name);
    });
  }

  /**
   * The draft of `resource`, unless another tab still keeps it. Reading it makes this tab its
   * keeper. A backup that is damaged or names another resource is not one.
   */
  async read(resource: URI): Promise<ITextFileBackup | undefined> {
    const name = this.lockName(resource);
    if (!this.locks?.own.has(name) && (await this.locks?.held())?.has(name)) {
      return undefined;
    }
    await this.queues.get(resource.toString());
    const backup = await this.readBackup(this.backupResource(resource));
    if (backup && backup.resource.toString() === resource.toString()) {
      this.locks?.hold(name);
      return backup;
    }
    return undefined;
  }

  /**
   * Deletes the backups whose resource is not in `keep` and that no tab keeps, and tells which
   * resources keep theirs. Startup calls it once the restored editors are open, so a draft whose
   * editor did not come back does not stay forever.
   */
  async discardUnused(keep: (resource: URI) => boolean): Promise<{ readonly discarded: URI[]; readonly kept: URI[] }> {
    const discarded: URI[] = [];
    const kept: URI[] = [];
    let names: string[];
    try {
      const stat = await this.fileService.resolve(this.root);
      names = (stat.children ?? []).filter(child => child.isFile).map(child => child.name);
    } catch (error) {
      if (toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound) {
        return { discarded, kept };
      }
      throw error;
    }
    const held = await this.locks?.held();
    for (const name of names) {
      const location = joinPath(this.root, name);
      const backup = await this.readBackup(location);
      if (backup && keep(backup.resource)) {
        kept.push(backup.resource);
      } else if (backup && held?.has(this.lockName(backup.resource))) {
        continue;
      } else if (backup) {
        await this.discard(backup.resource);
        discarded.push(backup.resource);
      } else if (!held?.has(`writing-room/backup${this.root.path}/${name}`)) {
        await this.deleteBackup(location);
      }
    }
    return { discarded, kept };
  }

  private queue(resource: URI, task: () => Promise<void>): Promise<void> {
    const key = resource.toString();
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

  private async readBackup(location: URI): Promise<ITextFileBackup | undefined> {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { ignoreBOM: true }).decode((await this.fileService.readFile(location)).value);
    } catch (error) {
      if (toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound) {
        return undefined;
      }
      throw error;
    }
    const newline = text.indexOf('\n');
    if (newline < 0) {
      return undefined;
    }
    try {
      const header: unknown = JSON.parse(text.slice(0, newline));
      if (typeof header !== 'object' || header === null) {
        return undefined;
      }
      const { version, resource, etag, bom } = header as Record<string, unknown>;
      if (version !== BACKUP_FORMAT || typeof resource !== 'string' || (etag !== null && typeof etag !== 'string')
        || typeof bom !== 'boolean') {
        return undefined;
      }
      return { resource: URI.parse(resource), value: text.slice(newline + 1), meta: { etag: etag ?? undefined, bom } };
    } catch {
      return undefined;
    }
  }
}

/** Web Locks where the browser has them; each held name stays held until released or the tab goes. */
function createBackupLocks(): IBackupLocks | undefined {
  const manager = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!manager) {
    return undefined;
  }
  const releases = new Map<string, () => void>();
  const own = new Set<string>();
  return {
    own,
    hold(name) {
      if (releases.has(name)) {
        return;
      }
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      releases.set(name, release);
      own.add(name);
      void manager.request(name, { mode: 'shared' }, () => held).catch(() => {
        releases.delete(name);
        own.delete(name);
      });
    },
    release(name) {
      releases.get(name)?.();
      releases.delete(name);
      own.delete(name);
    },
    async held() {
      try {
        const snapshot = await manager.query();
        return new Set((snapshot.held ?? []).flatMap(lock => lock.name ? [lock.name] : []));
      } catch {
        return undefined;
      }
    },
  };
}
