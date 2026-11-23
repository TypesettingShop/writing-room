import { DeferredPromise, RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { normalizeCharacterValues, type CharacterValues } from '../../../../platform/characters/common/characterFields.js';
import {
  CharacterStoreError, normalizeCharacterTitle, type CharacterEntry, type CharacterType,
} from '../../../../platform/characters/common/characters.js';
import type { CharactersStore } from '../../../../platform/characters/common/charactersStore.js';
import { Severity, type IDialogService, type IPromptHandle } from '../../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';

export interface CharacterCardValues {
  readonly title: string;
  readonly type: CharacterType;
  readonly values: Readonly<CharacterValues>;
}

export interface CharacterCardSnapshot {
  readonly node: CharacterEntry | undefined;
  readonly revision: number;
}

const idleDelay = 1000;

function sameValues(a: CharacterCardValues, b: CharacterCardValues): boolean {
  return a.title === b.title && a.type === b.type &&
    Object.keys(a.values).length === Object.keys(b.values).length &&
    Object.entries(a.values).every(([key, value]) => Object.hasOwn(b.values, key) && b.values[key] === value);
}

/** Compares drafts as the store saves them: it trims and NFC-normalizes the title. */
function sameContent(a: CharacterCardValues, b: CharacterCardValues): boolean {
  return sameValues({ ...a, title: a.title.trim().normalize('NFC') }, { ...b, title: b.title.trim().normalize('NFC') });
}

function cardValues(node: CharacterEntry): CharacterCardValues {
  return { title: node.title, type: node.type, values: node.values };
}

/** One model per open card, owned by the input that all its tabs share. */
export class CharacterCardModel extends Disposable {
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly autoSave = this._register(new RunOnceScheduler(() => { void this.save('auto'); }, idleDelay));
  private saved: CharacterCardValues;
  private current: CharacterCardValues;
  private revision: number;
  private saveInProgress: Promise<boolean> | undefined;
  private composition: DeferredPromise<void> | undefined;
  private compositions = 0;
  private deferredSnapshot: CharacterCardSnapshot | undefined;
  private discardInProgress = false;
  private conflictPrompt: IPromptHandle | undefined;
  private autoPaused = false;
  private _deleted = false;
  private disposed = false;

  constructor(
    private readonly workId: string,
    node: CharacterEntry,
    revision: number,
    private readonly characters: CharactersStore,
    private readonly readTree: (minimumRevision?: number) => Promise<CharacterCardSnapshot | undefined>,
    private readonly dialogs: IDialogService,
    private readonly notifications: INotificationService,
  ) {
    super();
    this.id = node.id;
    this.revision = revision;
    this.saved = this.current = cardValues(node);
  }

  readonly id: string;
  get draft(): CharacterCardValues { return this.current; }
  get deleted(): boolean { return this._deleted; }
  get dirty(): boolean { return !this.deleted && !sameContent(this.current, this.saved); }

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
          this.acceptTree(deferred);
        }
        this.scheduleAutoSave();
      }
    });
  }

  edit(draft: CharacterCardValues): void {
    if (this.disposed || (this.deleted && !this.composition) || sameValues(draft, this.current)) {
      return;
    }
    this.current = draft;
    this.autoPaused = false;
    this.changed.fire();
    this.scheduleAutoSave();
  }

  scheduleAutoSave(delay = idleDelay): void {
    this.autoSave.cancel();
    if (this.dirty && !this.composition && !this.autoPaused && !this.discardInProgress && !this.disposed) {
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

  acceptTree(snapshot: CharacterCardSnapshot): void {
    const { node, revision } = snapshot;
    if (this.deleted || this.disposed || revision < this.revision) {
      return;
    }
    if (!node) {
      this.markDeleted();
      return;
    }
    const next = cardValues(node);
    if (this.composition) {
      // The composing field still displays the old baseline, even before its first input event.
      this.deferredSnapshot = snapshot;
    } else if (!this.dirty) {
      this.saved = next;
      this.revision = revision;
      // Keep the typed title, such as a trailing space, while it saves as the same title.
      if (!sameContent(this.current, next)) {
        this.current = next;
      }
      this.changed.fire();
    }
    if (sameValues(this.saved, next)) {
      // The Work revision also covers unrelated cards and tree moves.
      this.revision = revision;
    }
  }

  markDeleted(): void {
    if (!this.deleted) {
      this._deleted = true;
      this.conflictPrompt?.close();
      this.autoSave.cancel();
      this.changed.fire();
    }
  }

  async waitForSave(): Promise<void> {
    await this.saveInProgress;
  }

  async save(reason: 'explicit' | 'auto'): Promise<boolean> {
    if (this.saveInProgress) {
      const pending = this.saveInProgress;
      const saved = await pending;
      if (reason === 'explicit' && saved && this.dirty && !this.discardInProgress) {
        return this.save(reason);
      }
      return saved;
    }
    if (this.deleted || this.disposed || this.discardInProgress) {
      return false;
    }
    if (!this.dirty) {
      return true;
    }
    if (reason === 'auto' && (this.composition || this.autoPaused)) {
      return false;
    }
    this.autoSave.cancel();
    const draftAtStart = this.current;
    const operation = this.write().finally(() => {
      this.saveInProgress = undefined;
      if (draftAtStart !== this.current) {
        this.scheduleAutoSave();
      }
    });
    this.saveInProgress = operation;
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
      const fresh = soft ? undefined : await this.readTree();
      this.current = this.saved;
      if (fresh) {
        this.acceptTree(fresh);
      }
      this.changed.fire();
    } finally {
      this.discardInProgress = false;
    }
  }

  private async write(): Promise<boolean> {
    let revision = this.revision;
    let base = this.saved;
    for (let attempt = 0; !this.deleted && !this.disposed; attempt++) {
      const submitted = this.current;
      try {
        const values = normalizeCharacterValues(submitted.values);
        const title = normalizeCharacterTitle(submitted.title);
        const result = await this.characters.updateNode(this.workId, this.id, { title, type: submitted.type, values }, revision);
        if (this.deleted || this.disposed || result.node.kind !== 'character') {
          return false;
        }
        this.revision = result.revision;
        this.saved = cardValues(result.node);
        // The store trims the title. Replacing a focused name that ends in a space would drop it mid-typing.
        if (this.current === submitted && !sameContent(submitted, this.saved)) {
          this.current = this.saved;
        }
        this.changed.fire();
        // The service change event can join a read started before this write.
        const fresh = await this.readTree(result.revision);
        if (fresh) {
          this.acceptTree(fresh);
        }
        return !this.deleted;
      } catch (error) {
        if (this.deleted || this.disposed) {
          return false;
        }
        if (error instanceof CharacterStoreError && error.code === 'not_found') {
          this.markDeleted();
          return false;
        }
        if (!(error instanceof CharacterStoreError) || error.code !== 'conflict') {
          this.notifications.error(error instanceof Error ? error.message : 'Could not save the character card.');
          return false;
        }
        if (attempt >= 3) {
          this.notifications.warn('Characters changed again while saving. Save the card to retry.');
          return false;
        }
        const fresh = await this.readTree(error.currentRevision);
        if (!fresh) {
          this.notifications.error('Could not reload characters to resolve the save conflict.');
          return false;
        }
        if (!fresh.node) {
          this.markDeleted();
          return false;
        }
        const latest = cardValues(fresh.node);
        if (!sameValues(base, latest)) {
          // Ctrl+S can capture preedit without making a modal take focus from a live IME.
          while (this.composition) {
            await this.composition.p;
          }
          if (this.deleted || this.disposed || this.discardInProgress) {
            return false;
          }
          const prompt = this.conflictPrompt = this.dialogs.prompt({
            type: Severity.Warning,
            message: `"${this.saved.title || 'Untitled'}" changed elsewhere.`,
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
            this.current = this.saved = latest;
            this.revision = fresh.revision;
            this.changed.fire();
            const current = await this.readTree(fresh.revision);
            if (current) {
              this.acceptTree(current);
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
    this.conflictPrompt?.close();
    void this.composition?.complete(undefined);
    this.composition = undefined;
    super.dispose();
  }
}
