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

export class CharacterEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.characterInput';

  private readonly changedIcon = this._register(new Emitter<void>());
  override readonly onDidChangeTabIcon = this.changedIcon.event;
  override readonly closeHandler: IEditorCloseHandler;

  readonly resource: URI;
  readonly model: CharacterCardModel;

  constructor(
    readonly workId: string,
    node: CharacterEntry,
    revision: number,
    @ICharactersViewState state: CharactersViewState,
    @ICharactersService characters: ICharactersService,
    @IDialogService dialogs: IDialogService,
    @IFileDialogService fileDialogs: IFileDialogService,
    @INotificationService notifications: INotificationService,
  ) {
    super();
    this.resource = characterUri(workId, node.id);
    const snapshot = (): CharacterCardSnapshot | undefined => {
      const current = state.index?.nodes.get(node.id);
      return state.revision === undefined ? undefined : {
        node: current?.kind === 'character' ? current : undefined, revision: state.revision,
      };
    };
    this.model = this._register(new CharacterCardModel(workId, node, revision, characters.store, async minimumRevision => {
      await state.refresh();
      // Refresh may join an older request already in flight.
      if (minimumRevision !== undefined && (state.revision ?? -1) < minimumRevision) {
        await state.refresh();
      }
      return !state.error && (minimumRevision === undefined || (state.revision ?? -1) >= minimumRevision)
        ? snapshot() : undefined;
    }, dialogs, notifications));

    this._register(state.onDidChangeTree(() => {
      const fresh = snapshot();
      if (fresh) {
        this.model.acceptTree(fresh);
      }
    }));

    let label = this.getName();
    let type = this.model.draft.type;
    let dirty = this.isDirty();
    let readonly = this.isReadonly();
    this._register(this.model.onDidChange(() => {
      const nextLabel = this.getName();
      const nextType = this.model.draft.type;
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

    this.closeHandler = {
      showConfirm: () => this.isDirty(),
      sharesDirtyState: other => other instanceof CharacterEditorInput && other.model === this.model,
      confirm: async editors => {
        this.model.pauseAutoSave();
        await this.model.waitForSave();
        if (!this.isDirty()) {
          return ConfirmResult.DONT_SAVE;
        }
        const result = await fileDialogs.showSaveConfirm(editors.map(({ editor }) => editor.getName()));
        if (result === ConfirmResult.CANCEL) {
          this.model.resumeAutoSave();
        }
        return result;
      },
    };
  }

  override get typeId(): string { return CharacterEditorInput.ID; }
  override getName(): string { return this.model.draft.title.trim() || 'Untitled'; }
  override getTabIcon() { return characterTypeIcon(this.model.draft.type); }
  override isReadonly(): boolean { return this.model.deleted; }
  override isDirty(): boolean { return this.model.dirty; }

  override matches(other: EditorInput): boolean {
    return other instanceof CharacterEditorInput && isEqual(this.resource, other.resource);
  }

  override async save(_group: GroupIdentifier, options?: ISaveOptions): Promise<CharacterEditorInput | undefined> {
    return await this.model.save(options?.reason ?? 'explicit') ? this : undefined;
  }

  override revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
    return this.model.revert(options?.soft === true);
  }
}
