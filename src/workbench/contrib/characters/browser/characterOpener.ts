import type { URI } from '../../../../base/common/uri.js';
import type { CharacterNode } from '../../../../platform/characters/common/characters.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorGroupsService, type IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { CharactersDragAndDropObserver } from '../../../browser/dnd.js';
import { registerNavigatorDropProvider } from '../../../browser/parts/editor/editorAreaDrops.js';
import { preorder, type NavigatorIndex } from '../../../common/navigator/navigatorTree.js';
import { CharacterEditorInput, characterId } from './characterEditorInput.js';
import { ICharactersViewState, type CharactersViewState } from './charactersViewState.js';

export const ICharacterOpener = createDecorator<CharacterOpener>('characterOpener');

const maxCharacters = 50;

function* charactersUnder(nodeId: string, index: NavigatorIndex<CharacterNode>): IterableIterator<string> {
  const node = index.nodes.get(nodeId);
  if (node?.kind === 'character') {
    yield node.id;
  } else if (node?.kind === 'folder') {
    for (const descendant of preorder(node.id, index)) {
      if (descendant.kind === 'character') {
        yield descendant.id;
      }
    }
  }
}

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

  isForWork(workId: string): boolean {
    return workId === this.state.workId;
  }

  hasCharacters(nodeIds: readonly string[]): boolean {
    const { index } = this.state;
    return index !== undefined && nodeIds.some(id => !charactersUnder(id, index).next().done);
  }

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
    const { index } = this.state;
    if (!index) {
      return;
    }
    const selected = new Set(nodeIds.flatMap(id => [...charactersUnder(id, index)]));
    const ids = nodeIds.length > 1
      ? [...preorder(null, index)].filter(node => selected.has(node.id)).map(node => node.id)
      : [...selected];

    let opened = 0;
    try {
      for (const id of ids.slice(0, maxCharacters)) {
        const input = this.inputFor(id);
        if (!input) {
          continue;
        }
        const target = options.group;
        const preferred = target && this.groups.getGroup(target.id) === target ? target : this.groups.activeGroup;
        const existing = preferred.contains(input) ? preferred : this.groups.groups.find(group => group.contains(input));
        const group = existing ?? preferred;
        await group.openEditor(input, {
          preserveFocus: options.preserveFocus || opened > 0,
          inactive: opened > 0,
          index: existing ? undefined : group.count,
        });
        opened++;
      }
    } catch (error) {
      this.notifications.error(error instanceof Error ? error.message : 'Could not open the character card.');
    }
    if (ids.length > maxCharacters) {
      this.notifications.info(`Opened ${opened} of ${ids.length} characters.`);
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

registerNavigatorDropProvider({
  observer: CharactersDragAndDropObserver.INSTANCE,
  isForWork: (accessor, workId) => accessor.get(ICharacterOpener).isForWork(workId),
  hasItems: (accessor, ids) => accessor.get(ICharacterOpener).hasCharacters(ids),
  open: (accessor, ids, group) => accessor.get(ICharacterOpener).openCharacters(ids, { group }),
});
