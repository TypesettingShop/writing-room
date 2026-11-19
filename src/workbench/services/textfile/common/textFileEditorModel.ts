import { RunOnceScheduler, Throttler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import type { Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IRange, ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import {
  FileOperationError, FileOperationResult, FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode,
} from '../../../../platform/files/common/files.js';
import type { ITextFileBackups } from './textFileBackup.js';
import {
  TEXT_FILE_SIZE_LIMIT, TextFileOperationError, TextFileOperationResult,
} from './textfiles.js';
import type {
  ITextFileEditorModel, ITextFileRevertOptions, ITextFileSaveErrorHandler, ITextFileSaveEvent,
  ITextFileSaveOptions, SaveReason,
} from './textfiles.js';

/** What a file model gets from the manager that made it. */
export interface ITextFileModelHost {
  readonly saveErrorHandler: ITextFileSaveErrorHandler;
  /** Runs the save participants (`ITextFileService.onWillSave`) and waits for them. */
  runSaveParticipants(model: ITextFileEditorModel, reason: SaveReason): Promise<void>;
  /** Where drafts go; without it nothing is backed up. */
  readonly backups: ITextFileBackups | undefined;
}

/** How long after a change the draft is written. */
export const BACKUP_DELAY = 1000;

/** VS Code reads this much of a file's start to tell text from binary. */
const BINARY_DETECTION_LENGTH = 512;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/** The version Monaco gives back on undo: the same number for the same text. */
function alternativeVersionId(model: ITextModel): number {
  return (model as ITextModel & { getAlternativeVersionId?(): number }).getAlternativeVersionId?.() ?? model.getVersionId();
}

function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];
}

function encode(text: string, bom: boolean): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (!bom) {
    return bytes;
  }
  const result = new Uint8Array(bytes.length + 3);
  result.set(UTF8_BOM);
  result.set(bytes, 3);
  return result;
}

/** A save that lost to another writer: the file changed (or went) since it was read. */
function isModifiedSince(error: unknown): boolean {
  return error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE;
}

function isNotFound(error: unknown): boolean {
  return toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound
    || (error instanceof TextFileOperationError && error.textFileOperationResult === TextFileOperationResult.FILE_NOT_FOUND);
}

/** The line break that comes first in `text`, or `undefined` when it has none. */
function firstLineBreak(text: string): '\n' | '\r\n' | undefined {
  const index = text.indexOf('\n');
  return index < 0 ? undefined : index > 0 && text[index - 1] === '\r' ? '\r\n' : '\n';
}

interface IReadFile {
  readonly text: string;
  readonly bom: boolean;
  readonly etag: string;
  readonly readonly: boolean;
}

/**
 * The text of one file in a text model: read as UTF-8 (a BOM is kept for the save), dirty while the
 * text differs from the saved version, saved one save at a time against the etag it was read with.
 * A draft of the unsaved text goes to the backups a second after each change.
 */
export class TextFileEditorModel extends Disposable implements ITextFileEditorModel {
  private readonly _onDidChangeDirty = this._register(new Emitter<void>());
  readonly onDidChangeDirty: Event<void> = this._onDidChangeDirty.event;
  private readonly _onDidChangeOrphaned = this._register(new Emitter<void>());
  readonly onDidChangeOrphaned: Event<void> = this._onDidChangeOrphaned.event;
  private readonly _onDidChangeReadonly = this._register(new Emitter<void>());
  readonly onDidChangeReadonly: Event<void> = this._onDidChangeReadonly.event;
  private readonly _onDidSave = this._register(new Emitter<ITextFileSaveEvent>());
  readonly onDidSave: Event<ITextFileSaveEvent> = this._onDidSave.event;
  private readonly _onDidRevert = this._register(new Emitter<void>());
  readonly onDidRevert: Event<void> = this._onDidRevert.event;
  private readonly _onDidChangeBackupState = this._register(new Emitter<void>());
  /** The draft became written, or stopped being. */
  readonly onDidChangeBackupState: Event<void> = this._onDidChangeBackupState.event;
  private readonly _onWillDispose = this._register(new Emitter<void>());
  readonly onWillDispose: Event<void> = this._onWillDispose.event;

  private model: ITextModel | null = null;
  private readonly modelListener = this._register(new MutableDisposable());
  private resolving: Promise<void> | undefined;
  /** The etag of the file the text was read from or last saved to; `undefined` when there was no file. */
  private etag: string | undefined;
  private bom = false;
  /** The alternative version id of the saved text; `undefined` when no version of the text is saved. */
  private savedVersionId: number | undefined;
  private dirty = false;
  private orphaned = false;
  private readonly = false;
  /** Set while this model changes its own text to the file's, which is no edit. */
  private ignoreContentChange = false;

  private saveRunning: Promise<boolean> | undefined;
  private saveQueued: Promise<boolean> | undefined;
  private readonly fileCheck = this._register(new Throttler());

  private readonly backupScheduler = this._register(new RunOnceScheduler(() => void this.writeBackup(), BACKUP_DELAY));
  private backupPending = false;
  private backupFailed = false;
  private disposed = false;

  constructor(
    readonly resource: URI,
    private readonly host: ITextFileModelHost,
    @IFileService private readonly fileService: IFileService,
    @IModelService private readonly modelService: IModelService,
  ) {
    super();
    // Providers that only report changes for what is watched report this file's.
    try {
      this._register(fileService.watch(resource));
    } catch (error) {
      console.warn(`Could not watch ${resource} for changes.`, error);
    }
  }

  get name(): string {
    return basename(this.resource);
  }

  get textEditorModel(): ITextModel | null {
    return this.model;
  }

  isResolved(): boolean {
    return this.model !== null;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  isOrphaned(): boolean {
    return this.orphaned;
  }

  isReadonly(): boolean {
    return this.readonly;
  }

  isSaving(): boolean {
    return this.saveRunning !== undefined;
  }

  /** A dirty text whose draft is not safely written yet: still waiting, being written, or failed. */
  hasUnsavedBackup(): boolean {
    return this.dirty && (this.backupPending || this.backupFailed);
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  // --- resolve

  /**
   * Reads the text once: from the draft of an earlier page when there is one (dirty), else from the
   * file. A failed read is not kept; the next call tries again.
   */
  resolve(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error(`${this.resource} is disposed.`));
    }
    this.resolving ??= this.doResolve().catch(error => {
      this.resolving = undefined;
      throw error;
    });
    return this.resolving;
  }

  private async doResolve(): Promise<void> {
    const backup = await this.host.backups?.read(this.resource).catch(error => {
      console.warn(`Could not read the backup of ${this.resource}.`, error);
      return undefined;
    });
    if (backup) {
      let orphaned = false;
      let readonly = false;
      try {
        readonly = (await this.fileService.stat(this.resource)).readonly;
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
        orphaned = true;
      }
      this.etag = backup.meta.etag;
      this.bom = backup.meta.bom;
      await this.createTextModel(backup.value);
      // The draft is what the user had; no version of it is saved.
      this.savedVersionId = undefined;
      this.setReadonly(readonly);
      this.setOrphaned(orphaned);
      this.setDirty(true);
      return;
    }
    const file = await this.readFile();
    this.etag = file.etag;
    this.bom = file.bom;
    await this.createTextModel(file.text);
    this.savedVersionId = alternativeVersionId(this.model!);
    this.setReadonly(file.readonly);
  }

  private async readFile(): Promise<IReadFile> {
    let content;
    try {
      content = await this.fileService.readFile(this.resource, { limits: { size: TEXT_FILE_SIZE_LIMIT } });
    } catch (error) {
      switch (toFileSystemProviderErrorCode(error)) {
        case FileSystemProviderErrorCode.FileTooLarge:
          throw new TextFileOperationError(`The file is larger than ${TEXT_FILE_SIZE_LIMIT / 1024 / 1024} MB.`,
            TextFileOperationResult.FILE_TOO_LARGE, { cause: error });
        case FileSystemProviderErrorCode.FileNotFound:
          throw new TextFileOperationError('The file was not found.', TextFileOperationResult.FILE_NOT_FOUND, { cause: error });
        case FileSystemProviderErrorCode.FileIsADirectory:
          throw new TextFileOperationError('The resource is a folder.', TextFileOperationResult.FILE_IS_DIRECTORY, { cause: error });
        default:
          throw error;
      }
    }
    const bytes = content.value;
    if (bytes.subarray(0, BINARY_DETECTION_LENGTH).includes(0)) {
      throw new TextFileOperationError('The file is binary or uses an unsupported text encoding.', TextFileOperationResult.FILE_IS_BINARY);
    }
    const bom = hasBom(bytes);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bom ? bytes.subarray(UTF8_BOM.length) : bytes);
    return { text, bom, etag: content.etag, readonly: content.readonly };
  }

  private async createTextModel(text: string): Promise<void> {
    const model = await this.modelService.createModel(text, undefined, this.resource);
    if (this.disposed) {
      model.dispose();
      throw new Error(`${this.resource} is disposed.`);
    }
    this.model = model;
    this.modelListener.value = model.onDidChangeContent(() => this.handleContentChange());
  }

  /**
   * Reads the file again into the text, which keeps the parts that did not change, and with them
   * the cursor and scroll of an editor that shows it. A missing file orphans the model instead.
   */
  private async reload(): Promise<void> {
    let file: IReadFile;
    try {
      file = await this.readFile();
    } catch (error) {
      if (isNotFound(error)) {
        this.setOrphaned(true);
        return;
      }
      throw error;
    }
    if (this.disposed || !this.model) {
      return;
    }
    this.etag = file.etag;
    this.bom = file.bom;
    this.updateText(file.text);
    this.savedVersionId = alternativeVersionId(this.model);
    this.setReadonly(file.readonly);
    this.setOrphaned(false);
    this.setDirty(false);
  }

  /** Replaces the text with `text` by one edit of the part that differs, as a change that is not the user's. */
  private updateText(text: string): void {
    const model = this.model!;
    type MonacoModel = ITextModel & {
      setEOL?(eol: 0 | 1): void;
      pushStackElement?(): void;
      pushEditOperations?(before: null, edits: { range: IRange; text: string }[], cursor: () => null): unknown;
    };
    const monaco = model as MonacoModel;
    this.ignoreContentChange = true;
    try {
      const lineBreak = firstLineBreak(text);
      if (lineBreak && lineBreak !== model.getEOL() && monaco.setEOL) {
        monaco.setEOL(lineBreak === '\r\n' ? 1 : 0);
      }
      const eol = model.getEOL();
      const next = text.replace(/\r\n|\r|\n/g, eol);
      const current = model.getValue();
      if (next === current) {
        return;
      }
      let start = 0;
      const shorter = Math.min(current.length, next.length);
      while (start < shorter && current.charCodeAt(start) === next.charCodeAt(start)) {
        start++;
      }
      let end = 0;
      while (end < shorter - start && current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) {
        end++;
      }
      const from = model.getPositionAt(start);
      const to = model.getPositionAt(current.length - end);
      const range = { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column };
      const edit = { range, text: next.slice(start, next.length - end) };
      if (monaco.pushEditOperations && monaco.pushStackElement) {
        // As VS Code's model service updates a model: an undoable step of its own.
        monaco.pushStackElement();
        monaco.pushEditOperations(null, [edit], () => null);
        monaco.pushStackElement();
      } else {
        model.applyEdits([edit]);
      }
    } finally {
      this.ignoreContentChange = false;
    }
  }

  private handleContentChange(): void {
    if (this.ignoreContentChange || !this.model) {
      return;
    }
    // Undo back to the saved text makes the model clean again.
    this.setDirty(alternativeVersionId(this.model) !== this.savedVersionId);
    if (this.dirty) {
      this.scheduleBackup();
    }
  }

  // --- state

  private setDirty(dirty: boolean): void {
    if (!dirty) {
      this.forgetBackup();
    }
    if (this.dirty !== dirty) {
      this.dirty = dirty;
      this._onDidChangeDirty.fire();
      this._onDidChangeBackupState.fire();
    }
  }

  private setOrphaned(orphaned: boolean): void {
    if (this.orphaned !== orphaned) {
      this.orphaned = orphaned;
      this._onDidChangeOrphaned.fire();
    }
  }

  private setReadonly(readonly: boolean): void {
    if (this.readonly !== readonly) {
      this.readonly = readonly;
      this._onDidChangeReadonly.fire();
    }
  }

  // --- external changes

  /**
   * The file changed on disk, or might have: after any save, a clean model reads it again, a dirty
   * one keeps its text for the next save to ask about, and a missing file orphans the model.
   */
  checkFile(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    return this.fileCheck.queue(() => this.doCheckFile()).catch(error => {
      console.warn(`Could not read the changes of ${this.resource}.`, error);
    });
  }

  private async doCheckFile(): Promise<void> {
    // A save's own write is no outside change, and the save knows the etag it got.
    while (this.saveRunning || this.saveQueued) {
      await (this.saveQueued ?? this.saveRunning)?.catch(() => {});
    }
    if (this.disposed || !this.model) {
      return;
    }
    let stat;
    try {
      stat = await this.fileService.stat(this.resource);
    } catch (error) {
      if (isNotFound(error)) {
        this.setOrphaned(true);
        return;
      }
      throw error;
    }
    if (this.disposed) {
      return;
    }
    this.setReadonly(stat.readonly);
    if (stat.etag === this.etag && !this.orphaned) {
      return;
    }
    if (this.dirty) {
      // The text stays; the etag stays too, so saving it asks before overwriting.
      this.setOrphaned(false);
      return;
    }
    await this.reload();
  }

  // --- save

  /**
   * Saves the text. Saves of one model go one at a time; while one runs, the next one waits and
   * any more join it, so the text saved last is the newest.
   */
  save(options: ITextFileSaveOptions = {}): Promise<boolean> {
    if (this.saveRunning) {
      if (!this.saveQueued) {
        const start = () => {
          this.saveQueued = undefined;
          return this.startSave(options);
        };
        this.saveQueued = this.saveRunning.then(start, start);
      }
      return this.saveQueued;
    }
    return this.startSave(options);
  }

  private startSave(options: ITextFileSaveOptions): Promise<boolean> {
    const running = this.doSave(options.reason ?? 'explicit').catch(error => {
      this.host.saveErrorHandler.onSaveError(error, this);
      return false;
    }).finally(() => {
      if (this.saveRunning === running) {
        this.saveRunning = undefined;
      }
    });
    this.saveRunning = running;
    return running;
  }

  private async doSave(reason: SaveReason): Promise<boolean> {
    if (this.disposed || !this.model || this.readonly) {
      return false;
    }
    if (!this.dirty && !this.orphaned) {
      return true;
    }
    try {
      await this.host.runSaveParticipants(this, reason);
    } catch (error) {
      console.warn(`A save participant of ${this.resource} failed.`, error);
    }
    let overwrite = false;
    for (;;) {
      if (this.disposed || !this.model) {
        return false;
      }
      if (!this.dirty && !this.orphaned) {
        return true;
      }
      // What the participants changed is part of this save; what is typed from here on is not.
      const versionId = alternativeVersionId(this.model);
      const bytes = encode(this.model.getValue(), this.bom);
      // A file that is gone is written anew; any other save holds to the file it read.
      const etag = overwrite || this.orphaned ? undefined : this.etag;
      try {
        const stat = await this.fileService.writeFile(this.resource, bytes, { etag });
        this.etag = stat.etag;
        this.savedVersionId = versionId;
        this.setReadonly(stat.readonly);
        this.setOrphaned(false);
        if (this.model && alternativeVersionId(this.model) === versionId) {
          this.setDirty(false);
        }
        this._onDidSave.fire({ resource: this.resource, reason });
        return true;
      } catch (error) {
        if (!isModifiedSince(error) || overwrite) {
          throw error;
        }
        const answer = await this.host.saveErrorHandler.resolveConflict(this).catch(() => 'cancel' as const);
        if (answer === 'overwrite') {
          overwrite = true;
          continue;
        }
        if (answer === 'revert' && !this.disposed) {
          await this.doRevert({});
        }
        return false;
      }
    }
  }

  // --- revert

  async revert(options: ITextFileRevertOptions = {}): Promise<void> {
    await this.doRevert(options);
  }

  private async doRevert(options: ITextFileRevertOptions): Promise<void> {
    if (this.disposed || !this.model) {
      return;
    }
    if (!options.soft) {
      await this.reload();
    }
    if (this.disposed || !this.model) {
      return;
    }
    this.savedVersionId = alternativeVersionId(this.model);
    this.setDirty(false);
    this._onDidRevert.fire();
  }

  // --- backup

  private scheduleBackup(): void {
    if (!this.host.backups) {
      return;
    }
    if (!this.backupPending) {
      this.backupPending = true;
      this._onDidChangeBackupState.fire();
    }
    this.backupScheduler.schedule();
  }

  private async writeBackup(): Promise<void> {
    const backups = this.host.backups;
    if (!backups || !this.dirty || !this.model || this.disposed) {
      return;
    }
    const versionId = this.model.getVersionId();
    try {
      await backups.write(this.resource, this.model.getValue(), { etag: this.etag, bom: this.bom });
      this.backupFailed = false;
    } catch (error) {
      console.warn(`Could not back up the unsaved text of ${this.resource}.`, error);
      this.backupFailed = true;
    }
    // A change made while it was written has its own backup on the way.
    if (this.model && this.model.getVersionId() === versionId && !this.backupScheduler.isScheduled()) {
      this.backupPending = false;
    }
    this._onDidChangeBackupState.fire();
  }

  /** The text is clean: its draft goes. */
  private forgetBackup(): void {
    this.backupScheduler.cancel();
    const changed = this.backupPending || this.backupFailed;
    this.backupPending = false;
    this.backupFailed = false;
    if (this.host.backups && (this.dirty || changed)) {
      void this.host.backups.discard(this.resource).catch(error =>
        console.warn(`Could not delete the backup of ${this.resource}.`, error));
    }
    if (changed) {
      this._onDidChangeBackupState.fire();
    }
  }

  /** Settles once no save is running or waiting. */
  async whenSaved(): Promise<void> {
    while (this.saveRunning || this.saveQueued) {
      await (this.saveQueued ?? this.saveRunning)?.catch(() => {});
    }
  }

  override dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this._onWillDispose.fire();
    const model = this.model;
    this.model = null;
    // A draft still pending stays as it was written last: the page may be going away.
    super.dispose();
    model?.dispose();
  }
}
