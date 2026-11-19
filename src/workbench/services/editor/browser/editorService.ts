import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { isResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import type { IResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { GroupModelChangeKind } from '../../../common/editor.js';
import type { GroupIdentifier, IEditorIdentifier, IEditorPane } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { GroupDirection, GroupsOrder, IEditorGroupsService } from '../common/editorGroupsService.js';
import type { IEditorGroup, IEditorOpenOptions } from '../common/editorGroupsService.js';
import { IEditorResolverService } from '../common/editorResolverService.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../common/editorService.js';
import type { IEditorCloseEvent, PreferredGroup } from '../common/editorService.js';

/** Editors across the groups of the editor part. */
export class EditorService extends Disposable implements IEditorService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidActiveEditorChange = this._register(new Emitter<void>());
  readonly onDidActiveEditorChange = this._onDidActiveEditorChange.event;
  private readonly _onDidVisibleEditorsChange = this._register(new Emitter<void>());
  readonly onDidVisibleEditorsChange = this._onDidVisibleEditorsChange.event;
  private readonly _onDidCloseEditor = this._register(new Emitter<IEditorCloseEvent>());
  readonly onDidCloseEditor = this._onDidCloseEditor.event;

  private readonly groupListeners = new Map<IEditorGroup, DisposableStore>();
  /** What `visibleEditors` was when `onDidVisibleEditorsChange` last fired. */
  private lastVisible: readonly EditorInput[];

  constructor(
    @IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
    @IEditorResolverService private readonly editorResolverService: IEditorResolverService,
  ) {
    super();
    this._register(toDisposable(() => {
      this.groupListeners.forEach(listeners => listeners.dispose());
      this.groupListeners.clear();
    }));
    this._register(editorGroupsService.onDidActiveEditorChange(() => this._onDidActiveEditorChange.fire()));
    for (const group of editorGroupsService.groups) {
      this.listenToGroup(group);
    }
    this._register(editorGroupsService.onDidAddGroup(group => {
      this.listenToGroup(group);
      this.updateVisibleEditors();
    }));
    this._register(editorGroupsService.onDidRemoveGroup(group => {
      this.groupListeners.get(group)?.dispose();
      this.groupListeners.delete(group);
      this.updateVisibleEditors();
    }));
    this._register(editorGroupsService.onDidMoveGroup(() => this.updateVisibleEditors()));
    this.lastVisible = this.visibleEditors;
  }

  private listenToGroup(group: IEditorGroup): void {
    const listeners = new DisposableStore();
    listeners.add(group.onDidActiveEditorChange(() => this.updateVisibleEditors()));
    listeners.add(group.onDidModelChange(event => {
      if (event.kind === GroupModelChangeKind.EDITOR_CLOSE && event.editor && event.editorIndex !== undefined) {
        this._onDidCloseEditor.fire({ groupId: group.id, editor: event.editor, index: event.editorIndex });
      }
    }));
    this.groupListeners.set(group, listeners);
  }

  /** Fires the visible editors event when the list really changed, so one change fires once. */
  private updateVisibleEditors(): void {
    const visible = this.visibleEditors;
    if (visible.length !== this.lastVisible.length || visible.some((editor, index) => editor !== this.lastVisible[index])) {
      this.lastVisible = visible;
      this._onDidVisibleEditorsChange.fire();
    }
  }

  get activeEditor(): EditorInput | undefined {
    return this.editorGroupsService.activeGroup.activeEditor ?? undefined;
  }

  get activeEditorPane(): IEditorPane | undefined {
    const group = this.editorGroupsService.activeGroup;
    return group.activeEditor ? group.activeEditorPane : undefined;
  }

  get editors(): readonly EditorInput[] {
    return this.editorGroupsService.groups.flatMap(group => group.editors);
  }

  get visibleEditors(): readonly EditorInput[] {
    return this.editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE)
      .flatMap(group => group.activeEditor ? [group.activeEditor] : []);
  }

  get visibleEditorPanes(): readonly IEditorPane[] {
    return this.editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE)
      .flatMap(group => group.activeEditor && group.activeEditorPane ? [group.activeEditorPane] : []);
  }

  openEditor(editor: EditorInput, options?: IEditorOpenOptions, group?: PreferredGroup): Promise<IEditorPane | undefined>;
  openEditor(editor: IResourceEditorInput, group?: PreferredGroup): Promise<IEditorPane | undefined>;
  async openEditor(
    editor: EditorInput | IResourceEditorInput, optionsOrGroup?: IEditorOpenOptions | PreferredGroup, preferred?: PreferredGroup,
  ): Promise<IEditorPane | undefined> {
    if (isResourceEditorInput(editor)) {
      const target = this.findTargetGroup(optionsOrGroup as PreferredGroup | undefined ?? ACTIVE_GROUP);
      const resolved = await this.editorResolverService.resolveEditor(editor, target);
      // The group may have gone while the input was made; the active one takes the editor then.
      const group = this.editorGroupsService.getGroup(target.id) === target ? target : this.editorGroupsService.activeGroup;
      return group.openEditor(resolved.editor, resolved.options);
    }
    return this.findTargetGroup(preferred ?? ACTIVE_GROUP).openEditor(editor, optionsOrGroup as IEditorOpenOptions | undefined);
  }

  findEditors(resource: URI, group?: IEditorGroup | GroupIdentifier): readonly IEditorIdentifier[] {
    const groups = group === undefined ? this.editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE)
      : [typeof group === 'number' ? this.editorGroupsService.getGroup(group) : group].filter(candidate => candidate !== undefined);
    return groups.flatMap(candidate => candidate.editors
      .filter(editor => isEqual(editor.resource, resource))
      .map(editor => ({ groupId: candidate.id, editor })));
  }

  private findTargetGroup(preferred: PreferredGroup): IEditorGroup {
    const groups = this.editorGroupsService;
    if (preferred === ACTIVE_GROUP) {
      return groups.activeGroup;
    }
    if (preferred === SIDE_GROUP) {
      return groups.findGroup({ direction: GroupDirection.RIGHT }, groups.activeGroup)
        ?? groups.addGroup(groups.activeGroup, GroupDirection.RIGHT);
    }
    const group = typeof preferred === 'number' ? groups.getGroup(preferred) : preferred;
    return group ?? groups.activeGroup;
  }
}

registerSingleton(IEditorService, EditorService);
