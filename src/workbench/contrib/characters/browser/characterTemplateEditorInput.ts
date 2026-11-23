import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import {
  CharacterTemplateValidationError, normalizeCharacterTemplate, type CharacterFieldDefinition, type CharacterTemplate,
} from '../../../../platform/characters/common/characterFields.js';
import { CharacterStoreError } from '../../../../platform/characters/common/characters.js';
import type { CharacterTemplateSnapshot } from '../../../../platform/characters/common/charactersStore.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, type BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { GroupIdentifier, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput, type IEditorCloseHandler, type IRevertOptions } from '../../../common/editor/editorInput.js';
import { ICharactersService } from '../../../services/characters/common/charactersService.js';
import { IFileDialogService } from '../../../services/dialogs/common/dialogs.js';
import { IWorkService } from '../../../services/work/common/work.js';

function equalFields(a: readonly CharacterFieldDefinition[], b: readonly CharacterFieldDefinition[]): boolean {
  return a.length === b.length && a.every((field, index) => {
    const other = b[index];
    return field.id === other.id && field.label === other.label && field.kind === other.kind
      && field.section === other.section && field.placeholder === other.placeholder
      && field.options?.length === other.options?.length
      && (field.options?.every((option, i) => option === other.options?.[i]) ?? true);
  });
}

export class CharacterTemplateEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.characterTemplate';
  readonly resource: URI;

  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChangeState = this.changed.event;
  private saved: CharacterTemplateSnapshot | undefined;
  private draft: CharacterTemplate | undefined;
  private conflictRevision: number | undefined;
  private readFailed = false;
  private readVersion = 0;
  private loading?: Promise<boolean>;
  private writing?: Promise<this | undefined>;
  private refreshAfterWrite = false;

  override readonly closeHandler: IEditorCloseHandler = {
    showConfirm: () => this.isDirty(),
    confirm: () => this.dialogs.showSaveConfirm([this.getName()]),
  };

  constructor(
    readonly workId: string,
    @ICharactersService private readonly characters: ICharactersService,
    @IFileDialogService private readonly dialogs: IFileDialogService,
    @INotificationService private readonly notifications: INotificationService,
  ) {
    super();
    this.resource = URI.from({ scheme: 'character-template', authority: workId });
    this._register(characters.onDidChangeTemplate(workId => {
      if (workId !== this.workId) {
        return;
      }
      // The service fires before the PUT promise settles, even for this input's own write.
      if (this.writing) {
        this.refreshAfterWrite = true;
      } else {
        void this.read();
      }
    }));
  }

  override get typeId(): string { return CharacterTemplateEditorInput.ID; }
  override getName(): string { return 'Field Template'; }
  get fields(): readonly CharacterFieldDefinition[] | undefined { return this.draft; }
  get hasConflict(): boolean { return this.conflictRevision !== undefined; }
  get hasReadError(): boolean { return this.readFailed; }
  get isSaving(): boolean { return this.writing !== undefined; }
  get canOverwrite(): boolean {
    return !this.isSaving && !this.readFailed && this.hasConflict && this.hasCurrentRevision() && this.isDirty();
  }

  override isDirty(): boolean {
    return !!this.saved && !!this.draft && !equalFields(this.saved.fields, this.draft);
  }

  setFields(fields: readonly CharacterFieldDefinition[]): void {
    if (!this.draft || this.isDisposed() || equalFields(this.draft, fields)) {
      return;
    }
    const wasDirty = this.isDirty();
    const current = new Set(this.draft);
    this.draft = fields.map(field => current.has(field) ? field : structuredClone(field));
    this.fireChange(wasDirty);
  }

  override async resolve(): Promise<this> {
    if (!this.saved && !this.isDisposed()) {
      await (this.loading ??= this.read().finally(() => { this.loading = undefined; }));
    }
    return this;
  }

  override save(): Promise<this | undefined> {
    if (this.writing) {
      return this.writing;
    }
    if (this.hasConflict || this.isDisposed()) {
      return Promise.resolve(undefined);
    }
    return this.saveDraft();
  }

  overwrite(): Promise<this | undefined> {
    return this.canOverwrite ? this.saveDraft() : Promise.resolve(undefined);
  }

  private saveDraft(): Promise<this | undefined> {
    if (this.isDisposed()) {
      return Promise.resolve(undefined);
    }
    if (!this.saved || !this.draft || !this.isDirty()) {
      return Promise.resolve(this);
    }
    const { revision } = this.saved;
    const draft = this.draft;
    // Set writing before the store can emit a change. Other Save requests share this result.
    this.writing = Promise.resolve().then(() => this.write(draft, revision)).finally(() => {
      this.writing = undefined;
      if (!this.isDisposed()) {
        this.changed.fire();
        if (this.refreshAfterWrite) {
          this.refreshAfterWrite = false;
          void this.read();
        }
      }
    });
    this.changed.fire();
    return this.writing;
  }

  override async revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
    await this.writing;
    if (options?.soft) {
      this.discardDraft();
    } else {
      await this.reload();
    }
  }

  async reload(): Promise<void> {
    const draft = this.draft;
    if (!this.writing && await this.read() && this.hasCurrentRevision()
      && (this.draft === draft || !this.isDirty())) {
      this.discardDraft();
    }
  }

  private async read(fromConflict = false): Promise<boolean> {
    const version = ++this.readVersion;
    try {
      const snapshot = await this.characters.store.getTemplate(this.workId);
      if (this.isDisposed()) {
        return false;
      }
      if (this.writing && !fromConflict) {
        this.refreshAfterWrite = true;
        return false;
      }
      const wasDirty = this.isDirty();
      if (!this.saved || snapshot.revision > this.saved.revision) {
        this.saved = snapshot;
        if (wasDirty && this.isDirty()) {
          this.markConflict(snapshot.revision);
        } else {
          this.draft = snapshot.fields;
          if (this.hasCurrentRevision()) {
            this.conflictRevision = undefined;
          }
        }
      }
      if (version === this.readVersion) {
        this.readFailed = !this.hasCurrentRevision();
      }
      this.fireChange(wasDirty);
      return true;
    } catch {
      if (version === this.readVersion && !this.isDisposed()) {
        this.readFailed = true;
        this.changed.fire();
      }
      return false;
    }
  }

  private async write(draft: CharacterTemplate, revision: number): Promise<this | undefined> {
    try {
      const fields = normalizeCharacterTemplate(draft);
      const saved = await this.characters.store.putTemplate(this.workId, fields, revision);
      if (this.isDisposed()) {
        return undefined;
      }
      const wasDirty = this.isDirty();
      if (this.draft && equalFields(this.draft, draft) && !equalFields(this.draft, saved.fields)) {
        this.draft = saved.fields;
      }
      this.saved = saved;
      this.conflictRevision = undefined;
      this.readFailed = false;
      this.fireChange(wasDirty);
      // A close waiting on this save must leave the editor open if more edits came in.
      return this.isDirty() ? undefined : this;
    } catch (error) {
      if (this.isDisposed()) {
        return undefined;
      }
      if (error instanceof CharacterStoreError && error.code === 'conflict') {
        this.markConflict(error.currentRevision ?? revision + 1);
        this.changed.fire();
        this.refreshAfterWrite = false;
        await this.read(true);
      } else {
        const detail = error instanceof CharacterTemplateValidationError ? error.detail
          : error instanceof Error ? error.message : '';
        this.notifications.error(detail ? `Could not save the field template. ${detail}` : 'Could not save the field template.');
      }
      return undefined;
    }
  }

  private markConflict(revision: number): void {
    if (this.conflictRevision === undefined || revision > this.conflictRevision) {
      this.conflictRevision = revision;
      this.notifications.warn('The field template changed since you opened or last saved it.');
    }
  }

  private hasCurrentRevision(): boolean {
    return this.conflictRevision === undefined || (this.saved?.revision ?? -1) >= this.conflictRevision;
  }

  private discardDraft(): void {
    if (this.saved && !this.isDisposed()) {
      const wasDirty = this.isDirty();
      this.draft = this.saved.fields;
      this.conflictRevision = undefined;
      this.fireChange(wasDirty);
    }
  }

  private fireChange(wasDirty: boolean): void {
    if (wasDirty !== this.isDirty()) {
      this._onDidChangeDirty.fire();
    }
    this.changed.fire();
  }
}

export const ICharacterTemplateInputService = createDecorator<ICharacterTemplateInputService>('characterTemplateInputService');

export interface ICharacterTemplateInputService extends BrandedService {
  getOrCreate(workId: string): CharacterTemplateEditorInput;
}

class CharacterTemplateInputService implements ICharacterTemplateInputService {
  declare readonly _serviceBrand: undefined;
  private readonly inputs = new Map<string, CharacterTemplateEditorInput>();

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  getOrCreate(workId: string): CharacterTemplateEditorInput {
    let input = this.inputs.get(workId);
    if (!input) {
      input = this.instantiation.createInstance(CharacterTemplateEditorInput, workId);
      this.inputs.set(workId, input);
      Event.once(input.onWillDispose)(() => this.inputs.delete(workId));
    }
    return input;
  }
}

registerSingleton(ICharacterTemplateInputService, CharacterTemplateInputService);

export class CharacterTemplateEditorSerializer implements IEditorSerializer {
  canSerialize(editor: EditorInput): boolean {
    return editor instanceof CharacterTemplateEditorInput;
  }

  serialize(editor: EditorInput): string | undefined {
    return editor instanceof CharacterTemplateEditorInput ? editor.workId : undefined;
  }

  deserialize(instantiation: IInstantiationService, workId: string): CharacterTemplateEditorInput | undefined {
    return instantiation.invokeFunction(accessor =>
      workId === accessor.get(IWorkService).current?.id
        ? accessor.get(ICharacterTemplateInputService).getOrCreate(workId)
        : undefined);
  }
}
