import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { InMemoryWorldRepository } from '../../../../platform/world/common/inMemoryWorldStore.js';
import type { WorldStore } from '../../../../platform/world/common/worldStore.js';
import type { WindowManuscriptService } from '../../manuscript/browser/windowManuscriptService.js';
import type { DeletedWorldNodes, IWorldService } from '../common/worldService.js';
import { HttpWorldStore } from './httpWorldStore.js';

export class WindowWorldService implements IWorldService {
  declare readonly _serviceBrand: undefined;
  private readonly disposables = new DisposableStore();
  private readonly changedTree = this.disposables.add(new Emitter<string>());
  private readonly changedCalendar = this.disposables.add(new Emitter<string>());
  private readonly deletedNodes = this.disposables.add(new Emitter<DeletedWorldNodes>());
  readonly onDidChangeTree = this.changedTree.event;
  readonly onDidChangeCalendar = this.changedCalendar.event;
  readonly onDidDeleteNodes = this.deletedNodes.event;
  readonly usesMemory: boolean;
  readonly store: WorldStore;

  constructor(
    manuscript: Pick<WindowManuscriptService, 'memoryWorkAccess' | 'status'>,
    createRemote: (status: WindowManuscriptService['status']) => WorldStore = status => new HttpWorldStore(status),
  ) {
    const memoryWorkAccess = manuscript.memoryWorkAccess;
    this.usesMemory = memoryWorkAccess !== undefined;
    const store = memoryWorkAccess
      ? new InMemoryWorldRepository(() => memoryWorkAccess).forUser('window')
      : createRemote(manuscript.status);
    this.store = {
      getTree: workId => store.getTree(workId),
      applyPreset: (workId, preset, expected) => this.changeTree(workId, expected, store.applyPreset(workId, preset, expected)),
      createNode: (workId, input, expected) => this.changeTree(workId, expected, store.createNode(workId, input, expected)),
      updateNode: (workId, id, input, expected) => this.changeTree(workId, expected, store.updateNode(workId, id, input, expected)),
      moveNodes: (workId, ids, destination, expected) => this.changeTree(workId, expected, store.moveNodes(workId, ids, destination, expected)),
      deleteNode: async (workId, id, expected) => {
        const result = await this.changeTree(workId, expected, store.deleteNode(workId, id, expected));
        if (result.deletedNodeIds.length) {
          this.deletedNodes.fire({ workId, nodeIds: [...result.deletedNodeIds] });
        }
        return result;
      },
      getCalendar: workId => store.getCalendar(workId),
      putCalendar: async (workId, calendar, expected) => {
        const result = await store.putCalendar(workId, calendar, expected);
        this.changedCalendar.fire(workId);
        return result;
      },
    };
  }

  dispose(): void {
    this.disposables.dispose();
  }

  private async changeTree<T extends { revision: number }>(workId: string, expected: number, operation: Promise<T>): Promise<T> {
    const result = await operation;
    if (result.revision !== expected) {
      this.changedTree.fire(workId);
    }
    return result;
  }
}
