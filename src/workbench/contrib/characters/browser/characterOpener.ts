import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorGroupsService, type IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { URI } from '../../../../base/common/uri.js';
import { CharacterEditorInput, characterId } from './characterEditorInput.js';
import { ICharactersViewState, type CharactersViewState } from './charactersViewState.js';

export const ICharacterOpener = createDecorator<CharacterOpener>('characterOpener');

interface OpenCharactersOptions {
  readonly group?: IEditorGroup;
  readonly preserveFocus?: boolean;
}

export class CharacterOpener {
  declare readonly _serviceBrand: undefined;
  // The cache covers parallel opens before their groups add a tab.
  private readonly inputs = new Map<string, CharacterEditorInput>();

  constructor(
    @ICharactersViewState private readonly state: CharactersViewState,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @INotificationService private readonly notifications: INotificationService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {}

  async resolveInput(resource: URI): Promise<CharacterEditorInput | undefined> {
    const id = characterId(resource, this.state.workId);
    if (id === undefined) {
      return undefined;
    }
    await this.state.ensureLoaded();
    return this.inputFor(id);
  }

  private inputFor(id: string): CharacterEditorInput | undefined {
    const existing = this.inputs.get(id);
    if (existing) {
      return existing;
    }
    const { index, revision, workId } = this.state;
    const node = index?.nodes.get(id);
    if (node?.kind !== 'character' || !workId || revision === undefined) {
      return undefined;
    }
    const input = this.instantiation.createInstance(CharacterEditorInput, workId, node, revision);
    this.inputs.set(id, input);
    input.onWillDispose(() => this.inputs.delete(id));
    return input;
  }

  async openCharacters(nodeIds: readonly string[], options: OpenCharactersOptions = {}): Promise<void> {
    await this.state.ensureLoaded();
    const preferred = options.group ?? this.groups.activeGroup;
    try {
      for (const id of new Set(nodeIds)) {
        const input = this.inputFor(id);
        if (!input) {
          continue;
        }
        const group = preferred.contains(input) ? preferred
          : this.groups.groups.find(group => group.contains(input)) ?? preferred;
        await group.openEditor(input, { preserveFocus: options.preserveFocus });
      }
    } catch (error) {
      this.notifications.error(error instanceof Error ? error.message : 'Could not open the character card.');
    }
  }

  closeDeleted(workId: string, nodeIds: readonly string[]): void {
    if (workId !== this.state.workId) {
      return;
    }
    const deleted = new Set(nodeIds);
    for (const id of deleted) {
      this.inputs.get(id)?.model.markDeleted();
    }
    for (const group of this.groups.groups) {
      const editors = group.editors.filter(editor => editor instanceof CharacterEditorInput &&
        editor.workId === workId && deleted.has(editor.model.id));
      if (editors.length) {
        void group.closeEditors(editors);
      }
    }
  }
}

registerSingleton(ICharacterOpener, CharacterOpener);
