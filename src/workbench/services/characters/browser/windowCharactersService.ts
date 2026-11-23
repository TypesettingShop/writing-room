import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { CharactersStore } from '../../../../platform/characters/common/charactersStore.js';
import { InMemoryCharactersRepository } from '../../../../platform/characters/common/inMemoryCharactersStore.js';
import type { WindowManuscriptService } from '../../manuscript/browser/windowManuscriptService.js';
import type { DeletedCharacters, ICharactersService } from '../common/charactersService.js';
import { HttpCharactersStore } from './httpCharactersStore.js';

export class WindowCharactersService implements ICharactersService {
  declare readonly _serviceBrand: undefined;
  private readonly disposables = new DisposableStore();
  private readonly changedTree = this.disposables.add(new Emitter<string>());
  private readonly changedTemplate = this.disposables.add(new Emitter<string>());
  private readonly deletedCharacters = this.disposables.add(new Emitter<DeletedCharacters>());
  readonly onDidChangeTree = this.changedTree.event;
  readonly onDidChangeTemplate = this.changedTemplate.event;
  readonly onDidDeleteCharacters = this.deletedCharacters.event;
  readonly usesMemory: boolean;
  readonly store: CharactersStore;

  constructor(
    manuscript: Pick<WindowManuscriptService, 'memoryWorkAccess' | 'status'>,
    createRemote: (status: WindowManuscriptService['status']) => CharactersStore = status => new HttpCharactersStore(status),
  ) {
    const memoryWorkAccess = manuscript.memoryWorkAccess;
    this.usesMemory = memoryWorkAccess !== undefined;
    const store = memoryWorkAccess
      ? new InMemoryCharactersRepository(() => memoryWorkAccess).forUser('window')
      : createRemote(manuscript.status);
    this.store = {
      getTemplate: workId => store.getTemplate(workId),
      putTemplate: (workId, fields, expected) => this.change(workId, expected, store.putTemplate(workId, fields, expected), this.changedTemplate),
      getTree: workId => store.getTree(workId),
      createNode: (workId, input, expected) => this.change(workId, expected, store.createNode(workId, input, expected)),
      updateNode: (workId, nodeId, input, expected) => this.change(workId, expected, store.updateNode(workId, nodeId, input, expected)),
      moveNodes: (workId, nodeIds, destination, expected) => this.change(workId, expected, store.moveNodes(workId, nodeIds, destination, expected)),
      deleteNode: async (workId, nodeId, expected) => {
        const result = await this.change(workId, expected, store.deleteNode(workId, nodeId, expected));
        if (result.deletedCharacterIds.length) {
          this.deletedCharacters.fire({ workId, nodeIds: [...result.deletedCharacterIds] });
        }
        return result;
      },
    };
  }

  dispose(): void {
    this.disposables.dispose();
  }

  private async change<T extends { revision: number }>(
    workId: string, expected: number, operation: Promise<T>, event = this.changedTree,
  ): Promise<T> {
    const result = await operation;
    if (result.revision !== expected) {
      event.fire(workId);
    }
    return result;
  }
}
