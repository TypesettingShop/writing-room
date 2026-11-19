import { raceCancellation } from '../../../base/common/async.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { isEqualOrParent } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { FileOperation } from '../../../platform/files/common/files.js';
import type { IFileChange, IFileService } from '../../../platform/files/common/files.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type {
  ExtHostFileSystemShape, FileOperationDto, FileOperationSubscription, FileWatcherBatch,
} from '../common/extHost.protocol.fileSystem.js';
import { ExtensionFileAccess, normalizeExtensionFileResource } from './extensionFileAccess.js';

interface ExtensionWatches {
  readonly handles: Map<number, { readonly roots: readonly URI[]; readonly registration: IDisposable }>;
  readonly pending: { readonly signature: string; readonly handles: readonly number[]; readonly changes: IFileChange[] }[];
}

const batchDelay = 25;
const batchLimit = 4096;
const participantTimeout = 5000;

function operationDto(operation: FileOperation, resource: URI, target?: URI): FileOperationDto | undefined {
  try {
    switch (operation) {
      case FileOperation.CREATE: return { kind: 'create', resource: normalizeExtensionFileResource(resource) };
      case FileOperation.DELETE: return { kind: 'delete', resource: normalizeExtensionFileResource(resource) };
      case FileOperation.MOVE: return target && { kind: 'rename',
        resource: normalizeExtensionFileResource(resource), target: normalizeExtensionFileResource(target) };
      case FileOperation.COPY: return target && { kind: 'create', resource: normalizeExtensionFileResource(target) };
    }
  } catch {
    return undefined;
  }
}

function isSubscription(value: string): boolean {
  return /^(?:did|will):(?:create|delete|rename)$/.test(value);
}

export class MainThreadFileSystemEventService extends Disposable {
  private readonly watches = new Map<string, ExtensionWatches>();
  private readonly subscriptions = new Map<FileOperationSubscription, Set<string>>();
  private readonly participants = new Set<CancellationTokenSource>();
  private pendingCount = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly files: IFileService,
    private readonly proxy: ExtHostFileSystemShape,
    private readonly access: ExtensionFileAccess,
    private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
    private readonly workspaceRoots: readonly URI[],
  ) {
    super();
    this._register(files.onDidFilesChange(({ changes }) => this.queueChanges(changes)));
    this._register(files.onWillRunOperation(event => {
      const change = operationDto(event.operation, event.resource, event.target);
      if (!change) {
        return;
      }
      const recipients = this.recipients(`will:${change.kind}`, change);
      if (recipients.length) {
        event.waitUntil(this.participate(recipients, change));
      }
    }));
    this._register(files.onDidRunOperation(event => {
      const change = operationDto(event.operation, event.resource, event.target?.resource);
      if (change) {
        const recipients = this.recipients(`did:${change.kind}`, change);
        if (recipients.length) {
          void proxy.$acceptFileOperation(recipients, change).catch(() => {});
        }
      }
    }));
  }

  watch(extension: HostExtensionDescription, handle: number, base?: URI): void {
    if (!Number.isSafeInteger(handle) || handle < 0) {
      throw new TypeError('Invalid file watcher handle.');
    }
    const roots = base === undefined ? this.workspaceRoots : [this.access.require(extension, base, false)];
    let entry = this.watches.get(extension.key);
    if (!entry) {
      entry = { handles: new Map(), pending: [] };
      this.watches.set(extension.key, entry);
    }
    if (entry.handles.has(handle)) {
      throw new Error('File watcher handle is already registered.');
    }
    const registrations = roots.map(root => this.files.watch(root, { recursive: true }));
    entry.handles.set(handle, { roots, registration: toDisposable(() => {
      for (const registration of registrations) {
        registration.dispose();
      }
    }) });
  }

  unwatch(extension: string, handle: number): void {
    const entry = this.watches.get(extension);
    const watch = entry?.handles.get(handle);
    if (watch && entry) {
      entry.handles.delete(handle);
      watch.registration.dispose();
      if (!entry.handles.size) {
        this.watches.delete(extension);
      }
    }
  }

  subscribe(extension: string, event: FileOperationSubscription, enabled: boolean): void {
    if (!isSubscription(event) || typeof enabled !== 'boolean') {
      throw new TypeError('Invalid file operation subscription.');
    }
    let recipients = this.subscriptions.get(event);
    if (enabled) {
      if (!recipients) {
        recipients = new Set();
        this.subscriptions.set(event, recipients);
      }
      recipients.add(extension);
    } else {
      recipients?.delete(extension);
    }
  }

  remove(extension: string): void {
    for (const recipients of this.subscriptions.values()) {
      recipients.delete(extension);
    }
    const watches = this.watches.get(extension);
    this.watches.delete(extension);
    if (watches) {
      for (const watch of watches.handles.values()) {
        watch.registration.dispose();
      }
    }
  }

  private queueChanges(changes: readonly IFileChange[]): void {
    if (!this.watches.size) {
      return;
    }
    for (const change of changes) {
      let resource: URI;
      try {
        resource = normalizeExtensionFileResource(change.resource);
      } catch {
        continue;
      }
      for (const [key, entry] of this.watches) {
        const extension = this.getExtension(key);
        if (!extension || !this.access.isAllowed(extension, resource, false)) {
          continue;
        }
        const handles = [...entry.handles].filter(([, { roots }]) => roots.some(root => isEqualOrParent(resource, root)))
          .map(([handle]) => handle);
        if (handles.length) {
          const signature = handles.join(',');
          let group = entry.pending.at(-1);
          if (group?.signature !== signature) {
            group = { signature, handles, changes: [] };
            entry.pending.push(group);
          }
          group.changes.push({ resource, type: change.type });
          if (++this.pendingCount >= batchLimit) {
            this.flush();
          }
        }
      }
    }
    if (this.pendingCount && this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), batchDelay);
    }
  }

  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCount = 0;
    const batches: FileWatcherBatch[] = [];
    for (const [extension, entry] of this.watches) {
      if (this.getExtension(extension)) {
        for (const group of entry.pending) {
          const handles = group.handles.filter(handle => entry.handles.has(handle));
          if (handles.length) {
            batches.push({ extension, handles, changes: group.changes });
          }
        }
      }
      entry.pending.length = 0;
    }
    if (batches.length) {
      void this.proxy.$acceptFileChanges(batches).catch(() => {});
    }
  }

  private recipients(subscription: FileOperationSubscription, event: FileOperationDto): string[] {
    const subscribers = this.subscriptions.get(subscription);
    if (!subscribers?.size) {
      return [];
    }
    return [...subscribers].filter(key => {
      const owner = this.getExtension(key);
      return !!owner && this.access.isAllowed(owner, event.resource, false)
        && (event.kind !== 'rename' || this.access.isAllowed(owner, event.target, false));
    });
  }

  private async participate(extensions: readonly string[], event: FileOperationDto): Promise<void> {
    const source = new CancellationTokenSource();
    this.participants.add(source);
    const timer = setTimeout(() => source.cancel(), participantTimeout);
    try {
      await raceCancellation(this.proxy.$participateInFileOperation(extensions, event, source.token), source.token);
    } catch {
      // A disconnected host must not prevent a file operation from completing.
    } finally {
      clearTimeout(timer);
      this.participants.delete(source);
      source.dispose();
    }
  }

  override dispose(): void {
    super.dispose();
    clearTimeout(this.timer);
    for (const source of this.participants) {
      source.cancel();
    }
    for (const key of this.watches.keys()) {
      this.remove(key);
    }
    this.subscriptions.clear();
  }
}
