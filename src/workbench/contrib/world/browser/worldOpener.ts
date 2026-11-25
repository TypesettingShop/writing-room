import type { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { WorldDragAndDropObserver } from '../../../browser/dnd.js';
import { registerNavigatorDropProvider } from '../../../browser/parts/editor/editorAreaDrops.js';
import { preorder } from '../../../common/navigator/navigatorTree.js';
import { IEditorGroupsService, type IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { worldItemId, WorldItemEditorInput } from './worldItemEditorInput.js';
import { IWorldViewState, type WorldViewState } from './worldViewState.js';

const maxItems = 50;
const calendarCommand = 'world.editCalendar';

export const IWorldOpener = createDecorator<WorldOpener>('worldOpener');

export class WorldOpener {
  declare readonly _serviceBrand: undefined;
  private readonly items = new Map<string, WorldItemEditorInput>();

  constructor(
    @IWorldViewState private readonly state: WorldViewState,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @INotificationService private readonly notifications: INotificationService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ICommandService private readonly commands: ICommandService,
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

  private existingInput(id: string): WorldItemEditorInput | undefined {
    const cached = this.items.get(id);
    if (cached) {
      return cached;
    }
    for (const group of this.groups.groups) {
      const existing = group.editors.find(editor =>
        editor instanceof WorldItemEditorInput && editor.workId === this.state.workId && editor.itemId === id);
      if (existing instanceof WorldItemEditorInput) {
        return existing;
      }
    }
    return undefined;
  }

  private itemInput(id: string): WorldItemEditorInput | undefined {
    const existing = this.existingInput(id);
    if (existing) {
      return existing;
    }
    const { index, revision, workId } = this.state;
    const node = index?.nodes.get(id);
    if (node?.kind !== 'item' || !workId || revision === undefined) {
      return undefined;
    }
    return this.remember(this.instantiation.createInstance(WorldItemEditorInput, workId, id, { node, revision }));
  }

  private remember(input: WorldItemEditorInput): WorldItemEditorInput {
    this.items.set(input.itemId, input);
    input.onWillDispose(() => this.items.delete(input.itemId));
    return input;
  }

  restoreInput(resource: URI): WorldItemEditorInput | undefined {
    const id = worldItemId(resource, this.state.workId);
    if (!id) {
      return undefined;
    }
    const loaded = this.itemInput(id);
    if (loaded) {
      return loaded;
    }
    if (this.state.index && !this.state.error) {
      return undefined;
    }
    const input = this.remember(this.instantiation.createInstance(WorldItemEditorInput, resource.authority, id, undefined));
    const listener = input.onDidChangePresentation(() => {
      if (input.availability === 'missing') {
        listener.dispose();
        void this.closeMissing(input);
      }
    });
    input.onWillDispose(() => listener.dispose());
    void input.resolve();
    return input;
  }

  private async closeMissing(input: WorldItemEditorInput): Promise<void> {
    for (const group of [...this.groups.groups]) {
      if (group.contains(input)) {
        await group.closeEditors([input]);
        if (this.groups.getGroup(group.id) === group && group.isEmpty) {
          this.groups.removeGroup(group, true);
        }
      }
    }
    if (!input.isDisposed()) {
      input.dispose();
    }
  }

  isForWork(workId: string): boolean {
    return workId === this.state.workId;
  }

  private selectedCards(nodeIds: readonly string[]): Set<string> {
    const selected = new Set<string>();
    const { index } = this.state;
    if (!index) {
      return selected;
    }
    for (const id of nodeIds) {
      const node = index.nodes.get(id);
      if (node?.kind === 'item' || node?.kind === 'calendar' && CommandsRegistry.getCommand(calendarCommand)) {
        selected.add(id);
      } else if (node?.kind === 'category') {
        for (const child of preorder(id, index)) {
          if (child.kind === 'item') {
            selected.add(child.id);
          }
        }
      }
    }
    return selected;
  }

  hasItems(nodeIds: readonly string[]): boolean {
    return this.selectedCards(nodeIds).size > 0;
  }

  openItem(id: string): Promise<void> {
    return this.openItems([id]);
  }

  async openCalendar(group?: IEditorGroup): Promise<void> {
    if (!CommandsRegistry.getCommand(calendarCommand)) {
      return;
    }
    try {
      if (group && this.groups.getGroup(group.id) === group) {
        this.groups.activateGroup(group);
      }
      await this.commands.executeCommand(calendarCommand);
    } catch (error) {
      this.notifications.error(error instanceof Error ? error.message : 'Could not open the calendar.');
    }
  }

  async openItems(nodeIds: readonly string[], targetGroup?: IEditorGroup): Promise<void> {
    await this.state.ensureLoaded();
    const { index } = this.state;
    if (!index) {
      return;
    }
    const selected = this.selectedCards(nodeIds);
    const ordered = nodeIds.length > 1
      ? [...preorder(null, index)].filter(node => selected.has(node.id)).map(node => node.id)
      : [...selected];
    const itemCount = ordered.filter(id => index.nodes.get(id)?.kind === 'item').length;
    let opened = 0;
    try {
      for (const id of ordered) {
        if (index.nodes.get(id)?.kind === 'calendar') {
          await this.openCalendar(targetGroup);
          continue;
        }
        if (opened === maxItems) {
          continue;
        }
        const input = this.itemInput(id);
        if (!input) {
          continue;
        }
        const preferred = targetGroup && this.groups.getGroup(targetGroup.id) === targetGroup
          ? targetGroup : this.groups.activeGroup;
        const existing = preferred.contains(input) ? preferred : this.groups.groups.find(group => group.contains(input));
        const group = existing ?? preferred;
        await group.openEditor(input, {
          preserveFocus: opened > 0,
          inactive: opened > 0,
          index: existing ? undefined : group.count,
        });
        opened++;
      }
    } catch (error) {
      this.notifications.error(error instanceof Error ? error.message : 'Could not open the item card.');
    }
    if (itemCount > maxItems) {
      this.notifications.info(`Opened ${opened} of ${itemCount} items.`);
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

registerNavigatorDropProvider({
  observer: WorldDragAndDropObserver.INSTANCE,
  isForWork: (accessor, workId) => accessor.get(IWorldOpener).isForWork(workId),
  hasItems: (accessor, ids) => accessor.get(IWorldOpener).hasItems(ids),
  open: (accessor, ids, group) => accessor.get(IWorldOpener).openItems(ids, group),
});
