import type * as vscode from 'vscode';
import { raceCancellation } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { normalize } from '../../../base/common/path.js';
import type { URI } from '../../../base/common/uri.js';
import { FileChangeType } from '../../../platform/files/common/files.js';
import type { IFileChange } from '../../../platform/files/common/files.js';
import type {
  FileOperationDto, FileOperationSubscription, FileWatcherBatch, MainThreadFileSystemShape, WorkspaceFolderDto,
} from './extHost.protocol.fileSystem.js';
import { promiseApiMethod } from './extHostApiRegistry.js';
import { compileFileGlob, toFileGlob } from './extHostFileSystemGlob.js';
import { WorkspaceEdit } from './extHostTypes.js';

type DidEvent = vscode.FileCreateEvent | vscode.FileDeleteEvent | vscode.FileRenameEvent;
type WillEvent = vscode.FileWillCreateEvent | vscode.FileWillDeleteEvent | vscode.FileWillRenameEvent;
type OperationEvent = DidEvent | WillEvent;

interface OperationListeners {
  readonly emitter: Emitter<OperationEvent>;
  count: number;
}

class FileSystemWatcher extends Disposable implements vscode.FileSystemWatcher {
  private readonly created = this._register(new Emitter<URI>());
  private readonly changed = this._register(new Emitter<URI>());
  private readonly deleted = this._register(new Emitter<URI>());
  readonly onDidCreate = this.created.event;
  readonly onDidChange = this.changed.event;
  readonly onDidDelete = this.deleted.event;

  constructor(
    private readonly matches: (uri: URI) => boolean,
    readonly ignoreCreateEvents: boolean,
    readonly ignoreChangeEvents: boolean,
    readonly ignoreDeleteEvents: boolean,
    unregister: () => void,
  ) {
    super();
    this._register(toDisposable(unregister));
  }

  accept({ resource, type }: IFileChange): void {
    if (!this.matches(resource)) {
      return;
    }
    switch (type) {
      case FileChangeType.ADDED: if (!this.ignoreCreateEvents) { this.created.fire(resource); } break;
      case FileChangeType.UPDATED: if (!this.ignoreChangeEvents) { this.changed.fire(resource); } break;
      case FileChangeType.DELETED: if (!this.ignoreDeleteEvents) { this.deleted.fire(resource); } break;
    }
  }
}

function didEvent(event: FileOperationDto): DidEvent {
  const resource = Object.freeze(event.resource);
  return event.kind === 'rename'
    ? Object.freeze({ files: Object.freeze([Object.freeze({ oldUri: resource, newUri: Object.freeze(event.target) })]) })
    : Object.freeze({ files: Object.freeze([resource]) });
}

export class ExtHostFileSystemEventService {
  private nextHandle = 0;
  private readonly watches = new Map<number, { key: string; watcher: FileSystemWatcher }>();
  private readonly listeners = new Map<string, Map<FileOperationSubscription, OperationListeners>>();
  private readonly applying = new Map<string, number>();

  constructor(
    private readonly proxy: MainThreadFileSystemShape,
    private readonly workspaceFolders: () => readonly WorkspaceFolderDto[],
    private readonly applyEdit: (extension: string, edit: WorkspaceEdit) => Promise<boolean>,
  ) {}

  createApi(key: string) {
    return {
      createFileSystemWatcher: (pattern: vscode.GlobPattern, ignoreCreate = false, ignoreChange = false, ignoreDelete = false) =>
        this.watch(key, pattern, ignoreCreate, ignoreChange, ignoreDelete),
      findFiles: promiseApiMethod(async (include: vscode.GlobPattern, exclude?: vscode.GlobPattern | null, maxResults?: number,
        token?: vscode.CancellationToken) => {
        if (token?.isCancellationRequested) {
          return [];
        }
        const cancellation = CancellationToken.isCancellationToken(token) ? token : undefined;
        const folders = this.workspaceFolders();
        return this.proxy.$findFiles(key, toFileGlob(include, folders),
          exclude == null ? exclude : toFileGlob(exclude, folders), maxResults, cancellation);
      }),
      onWillCreateFiles: this.event<vscode.FileWillCreateEvent>(key, 'will:create'),
      onDidCreateFiles: this.event<vscode.FileCreateEvent>(key, 'did:create'),
      onWillDeleteFiles: this.event<vscode.FileWillDeleteEvent>(key, 'will:delete'),
      onDidDeleteFiles: this.event<vscode.FileDeleteEvent>(key, 'did:delete'),
      onWillRenameFiles: this.event<vscode.FileWillRenameEvent>(key, 'will:rename'),
      onDidRenameFiles: this.event<vscode.FileRenameEvent>(key, 'did:rename'),
    } satisfies Pick<typeof vscode.workspace, 'createFileSystemWatcher' | 'findFiles' | 'onWillCreateFiles'
      | 'onDidCreateFiles' | 'onWillDeleteFiles' | 'onDidDeleteFiles' | 'onWillRenameFiles' | 'onDidRenameFiles'>;
  }

  private watch(key: string, pattern: vscode.GlobPattern, ignoreCreate: boolean, ignoreChange: boolean, ignoreDelete: boolean) {
    const folders = this.workspaceFolders();
    const raw = toFileGlob(pattern, folders);
    const glob = typeof raw === 'string' ? raw : { ...raw, base: raw.base.with({ path: normalize(raw.base.path) }) };
    const matchers = typeof glob === 'string' ? folders.map(folder => compileFileGlob(glob, folder.uri))
      : [compileFileGlob(glob, glob.base)];
    const handle = this.nextHandle++;
    const watcher = new FileSystemWatcher(uri => matchers.some(match => match(uri)), ignoreCreate, ignoreChange, ignoreDelete, () => {
      this.watches.delete(handle);
      void this.proxy.$unwatch(key, handle).catch(() => {});
    });
    this.watches.set(handle, { key, watcher });
    if (!ignoreCreate || !ignoreChange || !ignoreDelete) {
      void this.proxy.$watch(key, handle, typeof glob === 'string' ? undefined : glob.base).catch(() => watcher.dispose());
    }
    return watcher;
  }

  private event<T extends OperationEvent>(key: string, subscription: FileOperationSubscription): vscode.Event<T> {
    return (listener, thisArgs, disposables) => {
      let events = this.listeners.get(key);
      if (!events) {
        events = new Map();
        this.listeners.set(key, events);
      }
      let entry = events.get(subscription);
      if (!entry) {
        entry = { emitter: new Emitter(), count: 0 };
        events.set(subscription, entry);
        void this.proxy.$subscribeFileOperation(key, subscription, true).catch(() => {});
      }
      entry.count++;
      const registration = entry.emitter.event(event => listener.call(thisArgs, event as T));
      const disposable = toDisposable(() => {
        registration.dispose();
        if (--entry.count === 0 && events.get(subscription) === entry) {
          events.delete(subscription);
          entry.emitter.dispose();
          if (!events.size) {
            this.listeners.delete(key);
          }
          void this.proxy.$subscribeFileOperation(key, subscription, false).catch(() => {});
        }
      });
      disposables?.push(disposable);
      return disposable;
    };
  }

  async $acceptFileChanges(batches: readonly FileWatcherBatch[]): Promise<void> {
    for (const { extension, handles, changes } of batches) {
      for (const change of changes) {
        Object.freeze(change.resource);
        for (const handle of handles) {
          const entry = this.watches.get(handle);
          if (entry?.key === extension) {
            entry.watcher.accept(change);
          }
        }
      }
    }
  }

  async $acceptFileOperation(extensions: readonly string[], event: FileOperationDto): Promise<void> {
    const data = didEvent(event);
    for (const key of extensions) {
      this.listeners.get(key)?.get(`did:${event.kind}`)?.emitter.fire(data);
    }
  }

  async $participateInFileOperation(
    extensions: readonly string[], event: FileOperationDto, token = CancellationToken.None,
  ): Promise<void> {
    const data = didEvent(event);
    await Promise.all(extensions.map(async key => {
      const emitter = this.listeners.get(key)?.get(`will:${event.kind}`)?.emitter;
      // Applying a listener's WorkspaceEdit can perform file operations of its own.
      if (!emitter || token.isCancellationRequested || this.applying.has(key)) {
        return;
      }
      const pending: Promise<unknown>[] = [];
      let accepting = true;
      emitter.fire(Object.freeze({ ...data, token, waitUntil(thenable: PromiseLike<unknown>) {
        if (!accepting) {
          throw new Error('waitUntil must be called during the file operation event');
        }
        pending.push(Promise.resolve(thenable));
      } }));
      accepting = false;
      const results = await raceCancellation(Promise.allSettled(pending), token);
      for (const result of results ?? []) {
        if (token.isCancellationRequested || this.listeners.get(key)?.get(`will:${event.kind}`)?.emitter !== emitter) {
          break;
        }
        if (result.status === 'fulfilled' && result.value instanceof WorkspaceEdit) {
          this.applying.set(key, (this.applying.get(key) ?? 0) + 1);
          try {
            await this.applyEdit(key, result.value);
          } finally {
            const remaining = this.applying.get(key)! - 1;
            if (remaining) {
              this.applying.set(key, remaining);
            } else {
              this.applying.delete(key);
            }
          }
        }
      }
    }));
  }

  release(key: string): void {
    for (const { key: owner, watcher } of this.watches.values()) {
      if (owner === key) {
        watcher.dispose();
      }
    }
    const events = this.listeners.get(key);
    if (events) {
      for (const [subscription, { emitter }] of events) {
        emitter.dispose();
        void this.proxy.$subscribeFileOperation(key, subscription, false).catch(() => {});
      }
      events.clear();
      this.listeners.delete(key);
    }
  }

  dispose(): void {
    for (const { watcher } of this.watches.values()) {
      watcher.dispose();
    }
    for (const key of this.listeners.keys()) {
      this.release(key);
    }
  }
}
