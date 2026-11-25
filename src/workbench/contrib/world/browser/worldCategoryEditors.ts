import type { URI } from '../../../../base/common/uri.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { WorldCategoryEditorInput, worldCategoryId, worldCategoryUri } from './worldCategoryEditorInput.js';
import { IWorldViewState, type WorldViewState } from './worldViewState.js';

export const IWorldCategoryEditors = createDecorator<WorldCategoryEditors>('worldCategoryEditors');

export class WorldCategoryEditors {
  declare readonly _serviceBrand: undefined;
  private readonly inputs = new Map<string, WorldCategoryEditorInput>();

  constructor(
    @IWorldViewState private readonly state: WorldViewState,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {}

  getInput(resource: URI, restoring = false): WorldCategoryEditorInput | undefined {
    const workId = this.state.workId;
    const id = worldCategoryId(resource, workId);
    if (!id || !workId) {
      return undefined;
    }
    const cached = this.inputs.get(id);
    if (cached) {
      return cached;
    }
    const existing = this.groups.groups.flatMap(group => group.editors)
      .find(editor => editor instanceof WorldCategoryEditorInput && editor.workId === workId && editor.categoryId === id);
    if (existing instanceof WorldCategoryEditorInput) {
      return existing;
    }
    if (!restoring && this.state.index?.nodes.get(id)?.kind !== 'category') {
      return undefined;
    }
    const input = this.instantiation.createInstance(WorldCategoryEditorInput, workId, id);
    if (input.missing) {
      input.dispose();
      return undefined;
    }
    this.inputs.set(id, input);
    input.onWillDispose(() => this.inputs.delete(id));
    if (restoring) {
      const listener = input.onDidChangeState(() => {
        if (input.missing) {
          void this.closeInput(input, true);
        }
      });
      input.onWillDispose(() => listener.dispose());
      void input.resolve();
    }
    return input;
  }

  async open(categoryId: string): Promise<void> {
    const workId = this.state.workId;
    if (!workId) {
      return;
    }
    const input = this.getInput(worldCategoryUri(workId, categoryId));
    if (input) {
      const preferred = this.groups.activeGroup;
      const group = preferred.contains(input) ? preferred : this.groups.groups.find(group => group.contains(input)) ?? preferred;
      await group.openEditor(input);
    }
  }

  closeDeleted(workId: string, ids: readonly string[]): void {
    if (workId !== this.state.workId) {
      return;
    }
    for (const id of ids) {
      const input = this.inputs.get(id);
      if (input) {
        input.model?.markDeleted();
        void this.closeInput(input);
      }
    }
  }

  private async closeInput(input: WorldCategoryEditorInput, prune = false): Promise<void> {
    for (const group of [...this.groups.groups]) {
      if (group.contains(input)) {
        await group.closeEditors([input]);
        if (prune && this.groups.getGroup(group.id) === group && group.isEmpty) {
          this.groups.removeGroup(group, true);
        }
      }
    }
    if (prune && !input.isDisposed()) {
      input.dispose();
    }
  }
}

registerSingleton(IWorldCategoryEditors, WorldCategoryEditors);
