import { Emitter } from '../../../../base/common/event.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { CharacterFieldDefinition } from '../../../../platform/characters/common/characterFields.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { isManuscriptId } from '../../../../platform/manuscript/common/manuscript.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { WorldItem } from '../../../../platform/world/common/world.js';
import type { FieldCardSnapshot } from '../../../browser/fieldCard/fieldCardModel.js';
import type { GroupIdentifier } from '../../../common/editor.js';
import { ConfirmResult, EditorInput, type IEditorCloseHandler, type IRevertOptions, type ISaveOptions } from '../../../common/editor/editorInput.js';
import { breadcrumb } from '../../../common/navigator/navigatorTree.js';
import { IWorldService } from '../../../services/world/common/worldService.js';
import { worldItemDraft, WorldItemCardModel, type WorldItemDraft } from './worldItemCardModel.js';
import { IWorldViewState, type WorldViewState } from './worldViewState.js';

export const worldItemScheme = 'world-item';

export function worldItemUri(workId: string, nodeId: string): URI {
  return URI.from({ scheme: worldItemScheme, authority: workId, path: '/' + nodeId });
}

export function worldItemId(resource: URI, workId: string | undefined): string | undefined {
  const id = resource.path.slice(1);
  if (resource.scheme === worldItemScheme && isManuscriptId(workId) && resource.authority === workId &&
      resource.path.startsWith('/') && isManuscriptId(id) && !resource.query && !resource.fragment) {
    return id;
  }
  return undefined;
}

const noFields: readonly CharacterFieldDefinition[] = [];
type Availability = 'loading' | 'ready' | 'unavailable' | 'missing';

export class WorldItemEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.worldItemInput';
  readonly resource: URI;
  override readonly closeHandler: IEditorCloseHandler = {
    showConfirm: () => this.isDirty(),
    sharesDirtyState: other => other instanceof WorldItemEditorInput && !!this.model && this.model === other.model,
    confirm: async () => await this.model?.confirmClose() ? ConfirmResult.DONT_SAVE : ConfirmResult.CANCEL,
  };

  private readonly changedPresentation = this._register(new Emitter<void>());
  readonly onDidChangePresentation = this.changedPresentation.event;
  private _model: WorldItemCardModel | undefined;
  private _availability: Availability = 'loading';
  private _fields = noFields;
  private _categoryPath = '';
  private loading: Promise<WorldItemCardModel | null> | undefined;

  constructor(
    readonly workId: string,
    readonly itemId: string,
    initial: { node: WorldItem; revision: number } | undefined,
    @IWorldViewState private readonly state: WorldViewState,
    @IWorldService private readonly world: IWorldService,
    @IDialogService private readonly dialogs: IDialogService,
    @INotificationService private readonly notifications: INotificationService,
  ) {
    super();
    this.resource = worldItemUri(workId, itemId);
    if (initial) {
      this.acceptItem(initial.node, initial.revision);
    }
    this._register(state.onDidChangeTree(() => {
      this.acceptCurrentTree();
      this.changedPresentation.fire();
    }));
  }

  get model(): WorldItemCardModel | undefined { return this._model; }
  get availability(): Availability { return this._availability; }

  get fields(): readonly CharacterFieldDefinition[] { return this._fields; }
  get categoryPath(): string { return this._categoryPath; }

  override get typeId(): string { return WorldItemEditorInput.ID; }
  override getName(): string {
    return this.model ? this.model.draft.title.trim() || 'Untitled'
      : this.availability === 'loading' ? 'Loading item…' : 'Item unavailable';
  }
  override getTabIcon() { return { id: 'world-item' }; }
  override isReadonly(): boolean { return !this.model || this.model.deleted; }
  override isDirty(): boolean { return this.model?.dirty ?? false; }
  override matches(other: EditorInput): boolean {
    return other instanceof WorldItemEditorInput && isEqual(other.resource, this.resource);
  }

  override async save(_group: GroupIdentifier, options?: ISaveOptions): Promise<this | undefined> {
    return await this.model?.save(options?.reason ?? 'explicit') ? this : undefined;
  }

  override async revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
    await this.model?.revert(options?.soft === true);
  }

  override async resolve(): Promise<WorldItemCardModel | null> {
    if (this.model || this.isDisposed() || this.availability === 'missing') {
      return this.model ?? null;
    }
    return this.loading ??= this.load().finally(() => { this.loading = undefined; });
  }

  private async load(): Promise<WorldItemCardModel | null> {
    const retry = this.availability === 'unavailable';
    this.setAvailability('loading');
    await (retry ? this.state.refresh() : this.state.ensureLoaded());
    if (!this.isDisposed() && !this.model && this.availability !== 'missing') {
      if (this.state.error || this.state.revision === undefined) {
        this.setAvailability('unavailable');
      } else {
        this.acceptCurrentTree();
      }
    }
    return this.model ?? null;
  }

  private acceptCurrentTree(): void {
    const { index, revision } = this.state;
    if (revision !== undefined) {
      const node = index?.nodes.get(this.itemId);
      this.acceptItem(node?.kind === 'item' ? node : undefined, revision);
    }
  }

  private async read(minimumRevision?: number): Promise<FieldCardSnapshot<WorldItemDraft> | undefined> {
    await this.state.refresh();
    if (minimumRevision !== undefined && (this.state.revision ?? -1) < minimumRevision) {
      await this.state.refresh();
    }
    const { index, revision, error } = this.state;
    if (error || revision === undefined || revision < (minimumRevision ?? 0)) {
      return undefined;
    }
    const node = index?.nodes.get(this.itemId);
    return { revision, value: node?.kind === 'item' ? worldItemDraft(node) : undefined };
  }

  private acceptItem(node: WorldItem | undefined, revision: number): void {
    const index = this.state.index;
    if (node && index) {
      const parent = node.parentId ? index.nodes.get(node.parentId) : undefined;
      this._fields = parent?.kind === 'category' ? parent.fields : noFields;
      this._categoryPath = breadcrumb(node.parentId, index).join(' › ');
    }
    if (this.model) {
      this.model.acceptSnapshot({ revision, value: node && worldItemDraft(node) });
      return;
    }
    if (!node) {
      this.setAvailability('missing');
      return;
    }
    const model = this._model = this._register(new WorldItemCardModel(
      this.workId, node, revision, this.world.store, minimumRevision => this.read(minimumRevision),
      this.dialogs, this.notifications,
    ));
    let label = this.getName();
    let dirty = model.dirty;
    let deleted = model.deleted;
    this._register(model.onDidChange(() => {
      if (label !== this.getName() || deleted !== model.deleted) {
        label = this.getName();
        deleted = model.deleted;
        this._onDidChangeLabel.fire();
      }
      if (dirty !== model.dirty) {
        dirty = model.dirty;
        this._onDidChangeDirty.fire();
      }
    }));
    this.setAvailability('ready');
  }

  private setAvailability(availability: Availability): void {
    if (this._availability !== availability) {
      this._availability = availability;
      this._onDidChangeLabel.fire();
      this.changedPresentation.fire();
    }
  }
}
