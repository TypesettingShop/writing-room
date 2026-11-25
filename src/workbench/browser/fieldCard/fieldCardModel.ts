import { DeferredPromise, RunOnceScheduler } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Severity, type IDialogService, type IPromptHandle } from '../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../platform/notification/common/notification.js';

export interface FieldCardSnapshot<T> {
  readonly revision: number;
  /** An absent value in a successful read means the target was deleted. */
  readonly value?: T;
}

export interface FieldCardProblem {
  readonly fieldId: string;
  readonly message: string;
}

export interface FieldCardHold {
  readonly message: string;
}

export type FieldCardSaveBlock =
  | { readonly kind: 'validation'; readonly problems: readonly FieldCardProblem[] }
  | { readonly kind: 'confirmation'; readonly hold: FieldCardHold }
  | { readonly kind: 'reviewError'; readonly message: string };

export interface FieldCardAdapter<T> {
  read(minimumRevision?: number): Promise<FieldCardSnapshot<T> | undefined>;
  write(value: T, revision: number): Promise<{ revision: number; value: T } | undefined>;
  /** Return an object for a conflict, even if the store has no revision hint. */
  conflictRevision(error: unknown): { readonly revision?: number } | undefined;
  isNotFound(error: unknown): boolean;
  /** Compare saved content, excluding store metadata such as tree position. */
  sameSaved(a: T, b: T): boolean;
  /** Compare what drafts would save as, so equivalent raw input stays in the form. */
  sameContent(a: T, b: T): boolean;
  normalize(value: T): T;
  label(value: T): string;
  beforeSave?(): void;
  validate?(value: T): readonly FieldCardProblem[];
  review?(value: T, saved: T): Promise<FieldCardHold | undefined>;
}

interface BlockedSave<T> {
  readonly state: FieldCardSaveBlock;
  readonly draft: T;
  readonly base: T;
  readonly revision: number;
}

export interface FieldCardMessages {
  readonly saveError: string;
  readonly repeatedConflict: string;
  readonly reloadError: string;
}

const defaultMessages: FieldCardMessages = {
  saveError: 'Could not save the card.',
  repeatedConflict: 'The card changed again while saving. Save the card to retry.',
  reloadError: 'Could not reload the card to resolve the save conflict.',
};
const idleDelay = 1000;

/** One model per open card, owned by the input that all its tabs share. */
export class FieldCardModel<T extends object> extends Disposable {
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly autoSave = this._register(new RunOnceScheduler(() => { void this.save('auto'); }, idleDelay));
  private readonly focusBlock = this._register(new Emitter<FieldCardSaveBlock>());
  /** Panes use this to focus the first invalid control or the Apply Change button. */
  readonly onDidRequestSaveBlockFocus = this.focusBlock.event;
  private blocked: BlockedSave<T> | undefined;
  private closing = false;
  private closePrompt: IPromptHandle | undefined;
  private saved: T;
  private current: T;
  private editVersion = 0;
  private revision: number;
  private saveInProgress: Promise<boolean> | undefined;
  /** The edit version the in-flight save started from. */
  private saveStartVersion = 0;
  private composition: DeferredPromise<void> | undefined;
  private compositions = 0;
  private deferredFocus: FieldCardSaveBlock | undefined;
  private deferredSnapshot: FieldCardSnapshot<T> | undefined;
  private discardInProgress = false;
  private conflictPrompt: IPromptHandle | undefined;
  private autoPaused = false;
  private _deleted = false;
  private disposed = false;

  constructor(
    value: T,
    revision: number,
    private readonly adapter: FieldCardAdapter<T>,
    private readonly dialogs: IDialogService,
    private readonly notifications: INotificationService,
    private readonly messages: FieldCardMessages = defaultMessages,
  ) {
    super();
    this.revision = revision;
    this.saved = this.current = value;
  }

  get saveBlock(): FieldCardSaveBlock | undefined { return this.blocked?.state; }
  get draft(): T { return this.current; }
  get deleted(): boolean { return this._deleted; }
  get dirty(): boolean { return !this.deleted && !this.adapter.sameContent(this.current, this.saved); }
  /** Guarded saves check the draft first and drop a check that a newer edit replaced. */
  private get guarded(): boolean { return !!(this.adapter.validate || this.adapter.review); }

  beginComposition(): IDisposable {
    this.compositions++;
    this.composition ??= new DeferredPromise<void>();
    this.autoSave.cancel();
    return toDisposable(() => {
      if (--this.compositions === 0) {
        const composition = this.composition;
        this.composition = undefined;
        void composition?.complete(undefined);
        const deferred = this.deferredSnapshot;
        this.deferredSnapshot = undefined;
        if (deferred) {
          this.acceptSnapshot(deferred);
        }
        const focus = this.deferredFocus;
        this.deferredFocus = undefined;
        if (focus && focus === this.saveBlock) {
          this.focusBlock.fire(focus);
        }
        this.scheduleAutoSave();
      }
    });
  }

  edit(draft: T): void {
    if (this.disposed || (this.deleted && !this.composition) || this.adapter.sameSaved(draft, this.current)) {
      return;
    }
    this.current = draft;
    this.editVersion++;
    this.blocked = undefined;
    this.autoPaused = false;
    this.changed.fire();
    this.scheduleAutoSave();
  }

  scheduleAutoSave(delay = idleDelay): void {
    this.autoSave.cancel();
    if (this.dirty && !this.composition && !this.autoPaused && !this.blocked && !this.closing && !this.discardInProgress && !this.disposed) {
      this.autoSave.schedule(delay);
    }
  }

  pauseAutoSave(): void {
    this.autoPaused = true;
    this.autoSave.cancel();
  }

  resumeAutoSave(): void {
    this.autoPaused = false;
    this.scheduleAutoSave();
  }

  acceptSnapshot(snapshot: FieldCardSnapshot<T>): void {
    const { value: next, revision } = snapshot;
    if (this.deleted || this.disposed || revision < this.revision) {
      return;
    }
    if (!next) {
      this.markDeleted();
      return;
    }
    if (this.composition) {
      // The composing field still displays the old baseline, even before its first input event.
      this.deferredSnapshot = snapshot;
    } else if (!this.dirty) {
      this.saved = next;
      this.revision = revision;
      // Preserve raw input that saves as the same value.
      if (!this.adapter.sameContent(this.current, next)) {
        this.current = next;
      }
      this.changed.fire();
    }
    if (this.adapter.sameSaved(this.saved, next)) {
      // A store revision can also cover unrelated changes.
      this.revision = revision;
    }
  }

  markDeleted(): void {
    if (!this.deleted) {
      this._deleted = true;
      this.blocked = undefined;
      this.closePrompt?.close();
      this.conflictPrompt?.close();
      this.autoSave.cancel();
      this.changed.fire();
    }
  }

  async waitForSave(): Promise<void> {
    await this.saveInProgress;
  }

  save(reason: 'explicit' | 'auto'): Promise<boolean> {
    return this.saveDraft(reason);
  }

  applyChange(): Promise<boolean> {
    const approval = this.blocked;
    if (!approval || approval.state.kind === 'validation' || this.saveInProgress) {
      return Promise.resolve(false);
    }
    return this.saveDraft('explicit', approval);
  }

  retryReview(): Promise<boolean> {
    if (this.saveBlock?.kind !== 'reviewError' || this.saveInProgress) {
      return Promise.resolve(false);
    }
    this.blocked = undefined;
    this.changed.fire();
    return this.save('explicit');
  }

  discardDraft(): Promise<void> {
    return this.revert(true);
  }

  /** Call from the editor's close handler once the final tab sharing this model is closing. */
  async confirmClose(): Promise<boolean> {
    if (this.closing) {
      return false;
    }
    this.closing = true;
    this.autoSave.cancel();
    try {
      return await this.confirmCloseDraft();
    } finally {
      this.closing = false;
      this.scheduleAutoSave();
    }
  }

  private async confirmCloseDraft(): Promise<boolean> {
    await this.waitForSave();
    while (this.composition) {
      await this.composition.p;
    }
    if (this.disposed || !this.dirty) {
      return true;
    }

    const draft = this.current;
    const editVersion = this.editVersion;
    const block = this.blocked;
    const validationProblems = block?.state.kind === 'validation'
      ? block.state.problems
      : this.adapter.validate?.(draft);
    const invalid = !!validationProblems?.length;
    const buttons = invalid
      ? ['Keep Editing', 'Discard']
      : [block ? 'Apply and Close' : 'Save and Close', 'Discard', 'Cancel'];
    const prompt = this.closePrompt = this.dialogs.prompt({
      type: Severity.Warning,
      message: `Close "${this.adapter.label(draft) || 'Untitled'}" with unsaved changes?`,
      detail: invalid ? validationProblems?.[0]?.message
        : block?.state.kind === 'confirmation' ? block.state.hold.message
        : block?.state.kind === 'reviewError' ? block.state.message : undefined,
      buttons,
      cancelButton: invalid ? 0 : 2,
    });
    const choice = await prompt.result;
    this.closePrompt = undefined;
    if (this.disposed || this.deleted) {
      return true;
    }
    // The answer only applies to the draft offered in the dialog.
    if (editVersion !== this.editVersion || draft !== this.current) {
      return false;
    }
    if (choice === 1) {
      await this.discardDraft();
      return !this.dirty;
    }
    if (choice === 0 && !invalid) {
      const saved = await (block ? this.applyChange() : this.save('explicit'));
      return saved && !this.dirty;
    }
    return false;
  }

  private requestBlockFocus(block: FieldCardSaveBlock): void {
    if (this.composition) {
      this.deferredFocus = block;
    } else {
      this.focusBlock.fire(block);
    }
  }

  private async saveDraft(reason: 'explicit' | 'auto', approval?: BlockedSave<T>): Promise<boolean> {
    if (this.saveInProgress) {
      const pending = this.saveInProgress;
      const startVersion = this.saveStartVersion;
      const saved = await pending;
      // The pending save never tried an edit that replaced its draft while it was being checked.
      const superseded = this.guarded && startVersion !== this.editVersion && !this.blocked;
      if (reason === 'explicit' && (saved || superseded) && this.dirty && !this.discardInProgress) {
        return this.save(reason);
      }
      if (reason === 'explicit' && this.saveBlock) {
        this.requestBlockFocus(this.saveBlock);
      }
      return saved;
    }
    if (this.deleted || this.disposed || this.discardInProgress) {
      return false;
    }
    const dirty = this.dirty;
    if (dirty && reason === 'auto' && (this.composition || this.autoPaused)) {
      return false;
    }
    if (dirty || reason === 'explicit') {
      this.adapter.beforeSave?.();
    }
    if (!dirty) {
      return true;
    }
    if (this.blocked && !approval) {
      if (reason === 'explicit') {
        this.requestBlockFocus(this.blocked.state);
      }
      return false;
    }
    this.autoSave.cancel();
    const draftAtStart = this.current;
    const editVersion = this.editVersion;
    // A block can emit synchronously. Register the in-flight operation before calling guarded adapters.
    const write = this.guarded
      ? Promise.resolve().then(() => this.write(reason, editVersion, approval))
      : this.write(reason, editVersion, approval);
    const operation = write.finally(() => {
      this.saveInProgress = undefined;
      if (draftAtStart !== this.current || editVersion !== this.editVersion) {
        this.scheduleAutoSave();
      }
    });
    this.saveInProgress = operation;
    this.saveStartVersion = editVersion;
    return operation;
  }

  async revert(soft: boolean): Promise<void> {
    this.discardInProgress = true;
    this.autoSave.cancel();
    try {
      await this.saveInProgress;
      if (this.deleted || this.disposed) {
        return;
      }
      const fresh = soft ? undefined : await this.adapter.read();
      this.current = this.saved;
      this.blocked = undefined;
      if (fresh) {
        this.acceptSnapshot(fresh);
      }
      this.changed.fire();
    } finally {
      this.discardInProgress = false;
    }
  }

  private async write(
    reason: 'explicit' | 'auto', editVersion: number, approval: BlockedSave<T> | undefined,
  ): Promise<boolean> {
    let revision = approval?.revision ?? this.revision;
    let base = approval?.base ?? this.saved;
    const guarded = this.guarded;
    const canSubmit = () => !this.deleted && !this.disposed && !this.discardInProgress
      && (reason === 'explicit' || (!this.composition && !this.autoPaused))
      && (!guarded || this.editVersion === editVersion);
    const blockSave = (state: FieldCardSaveBlock, draft: T) => {
      this.blocked = { state, draft, base, revision };
      this.changed.fire();
      if (reason === 'explicit' && this.blocked?.state === state) {
        this.requestBlockFocus(state);
      }
    };
    for (let attempt = 0; guarded ? canSubmit() : !this.deleted && !this.disposed; attempt++) {
      const submitted = this.current;
      try {
        const problems = this.adapter.validate?.(submitted);
        if (problems?.length) {
          blockSave({ kind: 'validation', problems }, submitted);
          return false;
        }
        const normalized = this.adapter.normalize(submitted);
        if (this.adapter.review && !(approval?.draft === submitted && approval.revision === revision)) {
          let hold: FieldCardHold | undefined;
          try {
            hold = await this.adapter.review(normalized, base);
          } catch {
            if (canSubmit()) {
              blockSave({ kind: 'reviewError', message: 'Could not check what this change affects.' }, submitted);
            }
            return false;
          }
          if (!canSubmit()) {
            return false;
          }
          if (hold) {
            blockSave({ kind: 'confirmation', hold }, submitted);
            return false;
          }
        }
        const result = await this.adapter.write(normalized, revision);
        if (this.deleted || this.disposed || !result) {
          return false;
        }
        this.blocked = undefined;
        this.revision = result.revision;
        this.saved = result.value;
        // Retain equivalent raw input, including trailing spaces in a focused field.
        if (this.current === submitted && !this.adapter.sameContent(submitted, this.saved)) {
          this.current = this.saved;
        }
        this.changed.fire();
        // The service change event can join a read started before this write.
        const fresh = await this.adapter.read(result.revision);
        if (fresh) {
          this.acceptSnapshot(fresh);
        }
        return !this.deleted;
      } catch (error) {
        if (this.deleted || this.disposed) {
          return false;
        }
        if (this.adapter.isNotFound(error)) {
          this.markDeleted();
          return false;
        }
        const conflict = this.adapter.conflictRevision(error);
        if (!conflict) {
          this.notifications.error(error instanceof Error ? error.message : this.messages.saveError);
          return false;
        }
        if (attempt >= 3) {
          this.notifications.warn(this.messages.repeatedConflict);
          return false;
        }
        let fresh: FieldCardSnapshot<T> | undefined;
        try {
          fresh = await this.adapter.read(conflict.revision);
        } catch {
          // The conflict cannot be resolved before a fresh snapshot is available.
        }
        if (this.deleted || this.disposed || (guarded && !canSubmit())) {
          return false;
        }
        if (!fresh) {
          this.notifications.error(this.messages.reloadError);
          return false;
        }
        if (!fresh.value) {
          this.markDeleted();
          return false;
        }
        const latest = fresh.value;
        if (!this.adapter.sameSaved(base, latest)) {
          // Ctrl+S can capture preedit without making a modal take focus from a live IME.
          while (this.composition) {
            await this.composition.p;
          }
          if (this.deleted || this.disposed || this.discardInProgress) {
            return false;
          }
          const prompt = this.conflictPrompt = this.dialogs.prompt({
            type: Severity.Warning,
            message: `"${this.adapter.label(this.saved) || 'Untitled'}" changed elsewhere.`,
            detail: 'Reload to discard your edits and read the saved card. Overwrite replaces the other changes with your edits.',
            buttons: ['Reload', 'Overwrite', 'Cancel'],
            cancelButton: 2,
          });
          const choice = await prompt.result;
          this.conflictPrompt = undefined;
          if (this.deleted || this.disposed || this.discardInProgress) {
            return false;
          }
          if (choice === 0) {
            this.blocked = undefined;
            this.current = this.saved = latest;
            this.revision = fresh.revision;
            this.changed.fire();
            const current = await this.adapter.read(fresh.revision);
            if (current) {
              this.acceptSnapshot(current);
            }
            return !this.deleted;
          }
          if (choice !== 1) {
            this.pauseAutoSave();
            return false;
          }
        }
        // An overwrite only authorizes replacing the version we offered to reload.
        base = latest;
        revision = fresh.revision;
      }
    }
    return false;
  }

  override dispose(): void {
    this.disposed = true;
    this.closePrompt?.close();
    this.conflictPrompt?.close();
    void this.composition?.complete(undefined);
    this.composition = undefined;
    super.dispose();
  }
}
