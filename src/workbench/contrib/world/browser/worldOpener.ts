import type { URI } from '../../../../base/common/uri.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { worldItemId, WorldItemEditorInput } from './worldItemEditorInput.js';
import { IWorldViewState, type WorldViewState } from './worldViewState.js';

export const IWorldOpener = createDecorator<WorldOpener>('worldOpener');

export class WorldOpener {
  declare readonly _serviceBrand: undefined;
  private readonly items = new Map<string, WorldItemEditorInput>();

  constructor(
    @IWorldViewState private readonly state: WorldViewState,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @INotificationService private readonly notifications: INotificationService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {}

  async resolveInput(resource: URI): Promise<WorldItemEditorInput | undefined> {
    const id = worldItemId(resource, this.state.workId);
    if (!id) {
      return undefined;
    }
    const wasLoaded = this.state.index !== undefined;
    await this.state.ensureLoaded();
    let input = this.itemInput(id);
    if (!input && wasLoaded) {
      await this.state.refresh();
      input = this.itemInput(id);
    }
    return input;
  }

  private itemInput(id: string): WorldItemEditorInput | undefined {
    const cached = this.items.get(id);
    if (cached) {
      return cached;
    }
    const existing = this.groups.groups.flatMap(group => group.editors).find(editor =>
      editor instanceof WorldItemEditorInput && editor.workId === this.state.workId && editor.itemId === id);
    if (existing instanceof WorldItemEditorInput) {
      return existing;
    }
    const { index, revision, workId } = this.state;
    const node = index?.nodes.get(id);
    if (node?.kind !== 'item' || !workId || revision === undefined) {
      return undefined;
    }
    const input = this.instantiation.createInstance(WorldItemEditorInput, workId, id, { node, revision });
    this.items.set(id, input);
    input.onWillDispose(() => this.items.delete(id));
    return input;
  }

  async openItem(id: string): Promise<void> {
    await this.state.ensureLoaded();
    const input = this.itemInput(id);
    if (!input) {
      return;
    }
    const preferred = this.groups.activeGroup;
    const target = preferred.contains(input) ? preferred : this.groups.groups.find(group => group.contains(input)) ?? preferred;
    try {
      await target.openEditor(input);
    } catch (error) {
      this.notifications.error(error instanceof Error ? error.message : 'Could not open the item card.');
    }
  }

  closeDeleted(workId: string, ids: readonly string[]): void {
    if (workId !== this.state.workId) {
      return;
    }
    const deleted = new Set(ids);
    for (const id of deleted) {
      this.items.get(id)?.model?.markDeleted();
    }
    for (const group of this.groups.groups) {
      const editors = group.editors.filter(editor => editor instanceof WorldItemEditorInput &&
        editor.workId === workId && deleted.has(editor.itemId));
      if (editors.length) {
        void group.closeEditors(editors);
      }
    }
  }
}

registerSingleton(IWorldOpener, WorldOpener);

export function openWorldItem(accessor: ServicesAccessor, id: string): Promise<void> {
  return accessor.get(IWorldOpener).openItem(id);
}
