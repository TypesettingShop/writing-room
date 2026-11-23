import { Emitter } from '../../../../base/common/event.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { CharacterEntry } from '../../../../platform/characters/common/characters.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { isManuscriptId } from '../../../../platform/manuscript/common/manuscript.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { GroupIdentifier } from '../../../common/editor.js';
import { ConfirmResult, EditorInput, type IEditorCloseHandler, type IRevertOptions, type ISaveOptions } from '../../../common/editor/editorInput.js';
import { ICharactersService } from '../../../services/characters/common/charactersService.js';
import { IFileDialogService } from '../../../services/dialogs/common/dialogs.js';
import { CharacterCardModel, type CharacterCardSnapshot } from './characterCardModel.js';
import { characterTypeIcon } from './characterIcons.js';
import { ICharactersViewState, type CharactersViewState } from './charactersViewState.js';

export const characterScheme = 'character';

export function characterUri(workId: string, nodeId: string): URI {
  return URI.from({ scheme: characterScheme, authority: workId, path: '/' + nodeId });
}

export function characterId(resource: URI, workId: string | undefined): string | undefined {
  const id = resource.path.slice(1);
  if (resource.scheme === characterScheme && isManuscriptId(workId) && resource.authority === workId &&
      resource.path.startsWith('/') && isManuscriptId(id) && !resource.query && !resource.fragment) {
    return id;
  }
  return undefined;
}

type Availability = 'loading' | 'ready' | 'unavailable' | 'missing';

export class CharacterEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.characterInput';

  private readonly changedIcon = this._register(new Emitter<void>());
  override readonly onDidChangeTabIcon = this.changedIcon.event;
  private readonly changedAvailability = this._register(new Emitter<void>());
  readonly onDidChangeAvailability = this.changedAvailability.event;
  override readonly closeHandler: IEditorCloseHandler;

  readonly resource: URI;
  private _model: CharacterCardModel | undefined;
  private _availability: Availability = 'loading';
  private loading: Promise<CharacterCardModel | null> | undefined;

  constructor(
    readonly workId: string,
    readonly characterId: string,
    initial: { readonly node: CharacterEntry; readonly revision: number } | undefined,
    @ICharactersViewState private readonly state: CharactersViewState,
    @ICharactersService private readonly characters: ICharactersService,
    @IDialogService private readonly dialogs: IDialogService,
    @IFileDialogService fileDialogs: IFileDialogService,
    @INotificationService private readonly notifications: INotificationService,
  ) {
    super();
    this.resource = characterUri(workId, characterId);
    if (initial) {
      this.acceptTree(initial);
    }
    this._register(state.onDidChangeTree(() => {
      const fresh = this.snapshot();
      if (fresh) {
        this.acceptTree(fresh);
      }
    }));

    this.closeHandler = {
      showConfirm: () => this.isDirty(),
      sharesDirtyState: other => other instanceof CharacterEditorInput && !!this.model && other.model === this.model,
      confirm: async editors => {
        const model = this.model;
        model?.pauseAutoSave();
        await model?.waitForSave();
        if (!this.isDirty()) {
          return ConfirmResult.DONT_SAVE;
        }
        const result = await fileDialogs.showSaveConfirm(editors.map(({ editor }) => editor.getName()));
        if (result === ConfirmResult.CANCEL) {
          model?.resumeAutoSave();
        }
        return result;
      },
    };
  }

  get model(): CharacterCardModel | undefined { return this._model; }
  get availability(): Availability { return this._availability; }
  override get typeId(): string { return CharacterEditorInput.ID; }

  override getName(): string {
    if (this.model) {
      return this.model.draft.title.trim() || 'Untitled';
    }
    return this.availability === 'loading' ? 'Loading character…' : 'Character unavailable';
  }

  override getTabIcon() { return this.model ? characterTypeIcon(this.model.draft.type) : undefined; }
  override isReadonly(): boolean { return !this.model || this.model.deleted; }
  override isDirty(): boolean { return this.model?.dirty ?? false; }

  override matches(other: EditorInput): boolean {
    return other instanceof CharacterEditorInput && isEqual(this.resource, other.resource);
  }

  override async save(_group: GroupIdentifier, options?: ISaveOptions): Promise<CharacterEditorInput | undefined> {
    return await this.model?.save(options?.reason ?? 'explicit') ? this : undefined;
  }

  override async revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
    await this.model?.revert(options?.soft === true);
  }

  override async resolve(): Promise<CharacterCardModel | null> {
    if (this.model || this.isDisposed() || this.availability === 'missing') {
      return this.model ?? null;
    }
    return this.loading ??= this.load().finally(() => { this.loading = undefined; });
  }

  private async load(): Promise<CharacterCardModel | null> {
    const retry = this.availability === 'unavailable';
    this.setAvailability('loading');
    await (retry ? this.state.refresh() : this.state.ensureLoaded());
    if (!this.isDisposed() && !this.model && this.availability !== 'missing') {
      const snapshot = this.snapshot();
      if (snapshot && !this.state.error) {
        this.acceptTree(snapshot);
      } else {
        this.setAvailability('unavailable');
      }
    }
    return this.model ?? null;
  }

  private snapshot(): CharacterCardSnapshot | undefined {
    const { index, revision } = this.state;
    const node = index?.nodes.get(this.characterId);
    return revision === undefined ? undefined : { node: node?.kind === 'character' ? node : undefined, revision };
  }

  private acceptTree(snapshot: CharacterCardSnapshot): void {
    if (this.model) {
      this.model.acceptTree(snapshot);
      return;
    }
    if (!snapshot.node) {
      this.setAvailability('missing');
      return;
    }
    const model = this._model = this._register(new CharacterCardModel(
      this.workId, snapshot.node, snapshot.revision, this.characters.store,
      async minimumRevision => {
        await this.state.refresh();
        // Refresh may join an older request already in flight.
        if (minimumRevision !== undefined && (this.state.revision ?? -1) < minimumRevision) {
          await this.state.refresh();
        }
        return !this.state.error && (minimumRevision === undefined || (this.state.revision ?? -1) >= minimumRevision)
          ? this.snapshot() : undefined;
      }, this.dialogs, this.notifications,
    ));

    let label = this.getName();
    let type = model.draft.type;
    let dirty = this.isDirty();
    let readonly = this.isReadonly();
    this._register(model.onDidChange(() => {
      const nextLabel = this.getName();
      const nextType = model.draft.type;
      const nextDirty = this.isDirty();
      const nextReadonly = this.isReadonly();
      if (label !== nextLabel || readonly !== nextReadonly) {
        label = nextLabel;
        readonly = nextReadonly;
        this._onDidChangeLabel.fire();
      }
      if (type !== nextType) {
        type = nextType;
        this.changedIcon.fire();
      }
      if (dirty !== nextDirty) {
        dirty = nextDirty;
        this._onDidChangeDirty.fire();
      }
    }));
    this.setAvailability('ready');
  }

  private setAvailability(availability: Availability): void {
    if (this.availability !== availability) {
      this._availability = availability;
      this._onDidChangeLabel.fire();
      this.changedIcon.fire();
      this.changedAvailability.fire();
    }
  }
}
