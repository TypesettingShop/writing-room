import { Emitter } from '../../../../base/common/event.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { CharacterFieldDefinition } from '../../../../platform/characters/common/characterFields.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { isManuscriptId } from '../../../../platform/manuscript/common/manuscript.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { WorldCategory } from '../../../../platform/world/common/world.js';
import type { GroupIdentifier } from '../../../common/editor.js';
import { ConfirmResult, EditorInput, type IEditorCloseHandler, type IRevertOptions, type ISaveOptions } from '../../../common/editor/editorInput.js';
import { IWorldService } from '../../../services/world/common/worldService.js';
import { WorldCategoryFieldsModel } from './worldCategoryFieldsModel.js';
import { IWorldViewState, type WorldViewState } from './worldViewState.js';

export const worldCategoryScheme = 'world-category';

export function worldCategoryUri(workId: string, categoryId: string): URI {
  return URI.from({ scheme: worldCategoryScheme, authority: workId, path: '/' + categoryId });
}

export function worldCategoryId(resource: URI, workId: string | undefined): string | undefined {
  const id = resource.path.slice(1);
  if (resource.scheme === worldCategoryScheme && isManuscriptId(workId) && resource.authority === workId &&
      resource.path.startsWith('/') && isManuscriptId(id) && !resource.query && !resource.fragment) {
    return id;
  }
  return undefined;
}

export class WorldCategoryEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.worldCategoryFieldsInput';
  readonly resource: URI;
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChangeState = this.changed.event;
  override readonly closeHandler: IEditorCloseHandler = {
    showConfirm: () => this.isDirty(),
    sharesDirtyState: other => other instanceof WorldCategoryEditorInput && !!this.model && this.model === other.model,
    confirm: async () => await this.model?.confirmClose() ? ConfirmResult.DONT_SAVE : ConfirmResult.CANCEL,
  };

  private _model: WorldCategoryFieldsModel | undefined;
  private _readFailed = false;
  private _missing = false;
  private title = '';
  private loading: Promise<WorldCategoryFieldsModel | null> | undefined;

  constructor(
    readonly workId: string,
    readonly categoryId: string,
    @IWorldViewState private readonly state: WorldViewState,
    @IWorldService private readonly world: IWorldService,
    @IDialogService private readonly dialogs: IDialogService,
    @INotificationService private readonly notifications: INotificationService,
  ) {
    super();
    this.resource = worldCategoryUri(workId, categoryId);
    this._register(state.onDidChangeTree(() => this.acceptTree()));
    let readError = state.error;
    this._register(state.onDidChange(() => {
      if (readError !== state.error) {
        readError = state.error;
        this.changed.fire();
      }
    }));
    if (!state.error) {
      this.acceptTree();
    }
  }

  get model(): WorldCategoryFieldsModel | undefined { return this._model; }
  get readFailed(): boolean { return this._readFailed || !!this.state.error; }
  get missing(): boolean { return this._missing || this.model?.deleted === true; }
  get fields(): readonly CharacterFieldDefinition[] | undefined { return this.missing ? undefined : this.model?.draft.fields; }

  setFields(fields: readonly CharacterFieldDefinition[]): void {
    this.model?.edit({ fields });
  }

  beginComposition() { return this.model?.beginComposition(); }

  override get typeId(): string { return WorldCategoryEditorInput.ID; }
  override getName(): string { return (this.title || 'Untitled') + ' Fields'; }
  override getTabIcon() { return { id: 'world-category' }; }
  override isReadonly(): boolean { return !this.model || this.missing; }
  override isDirty(): boolean { return this.model?.dirty ?? false; }
  override matches(other: EditorInput): boolean {
    return other instanceof WorldCategoryEditorInput && isEqual(this.resource, other.resource);
  }

  override async save(_group: GroupIdentifier, options?: ISaveOptions): Promise<this | undefined> {
    return await this.model?.save(options?.reason ?? 'explicit') ? this : undefined;
  }

  override async revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
    await this.model?.revert(options?.soft === true);
  }

  override async resolve(): Promise<WorldCategoryFieldsModel | null> {
    if (this.model || this.isDisposed() || this.missing) {
      return this.model ?? null;
    }
    return this.retry();
  }

  retry(): Promise<WorldCategoryFieldsModel | null> {
    return this.loading ??= this.load().finally(() => { this.loading = undefined; });
  }

  private async load(): Promise<WorldCategoryFieldsModel | null> {
    await this.state.refresh();
    if (!this.isDisposed()) {
      this._readFailed = !!this.state.error;
      if (!this._readFailed && !this.model && !this.missing) {
        this.acceptTree();
      }
      this.changed.fire();
    }
    return this.model ?? null;
  }

  private node(): WorldCategory | undefined {
    const node = this.state.index?.nodes.get(this.categoryId);
    return node?.kind === 'category' ? node : undefined;
  }

  private acceptTree(): void {
    const { revision } = this.state;
    if (revision === undefined || this.isDisposed()) {
      return;
    }
    const node = this.node();
    this._readFailed = false;
    if (node && this.title !== node.title) {
      this.title = node.title;
      this._onDidChangeLabel.fire();
    }
    if (this.model) {
      this.model.acceptSnapshot({ revision, value: node && { fields: node.fields } });
    } else if (node) {
      const model = this._model = this._register(new WorldCategoryFieldsModel(
        this.workId, node, revision, this.world.store, async minimumRevision => {
          await this.state.refresh();
          if (minimumRevision !== undefined && (this.state.revision ?? -1) < minimumRevision) {
            await this.state.refresh();
          }
          const revision = this.state.revision;
          if (this.state.error || revision === undefined || revision < (minimumRevision ?? 0)) {
            return undefined;
          }
          const node = this.node();
          return { revision, value: node && { fields: node.fields } };
        }, () => this.title, this.dialogs, this.notifications,
      ));
      let dirty = model.dirty;
      this._register(model.onDidChange(() => {
        if (dirty !== model.dirty) {
          dirty = model.dirty;
          this._onDidChangeDirty.fire();
        }
        this.changed.fire();
      }));
    } else if (this.state.index) {
      this._missing = true;
    }
    this.changed.fire();
  }
}
