import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { InMemoryManuscriptRepository } from '../../../../platform/manuscript/common/inMemoryManuscriptStore.js';
import type { ManuscriptStore, TreeChange } from '../../../../platform/manuscript/common/manuscriptStore.js';
import type {
  DeletedManuscriptDocuments, IManuscriptService, ManuscriptAvailability,
} from '../common/manuscriptService.js';

export class ManuscriptStatus extends Disposable {
  private current: ManuscriptAvailability = 'ready';
  private readonly changed = this._register(new Emitter<ManuscriptAvailability>());
  private readonly authChanged = this._register(new Emitter<void>());
  readonly onDidChangeAvailability = this.changed.event;
  readonly onDidChangeAuth = this.authChanged.event;

  get availability(): ManuscriptAvailability {
    return this.current;
  }

  set(availability: ManuscriptAvailability): void {
    if (this.current === availability) {
      return;
    }
    const authChanged = this.current === 'signedOut' || availability === 'signedOut';
    this.current = availability;
    this.changed.fire(availability);
    if (authChanged) {
      this.authChanged.fire();
    }
  }
}

export class WindowManuscriptService implements IManuscriptService {
  declare readonly _serviceBrand: undefined;
  private readonly disposables = new DisposableStore();
  private readonly status = this.disposables.add(new ManuscriptStatus());
  private readonly changedTree = this.disposables.add(new Emitter<string>());
  private readonly deletedDocuments = this.disposables.add(new Emitter<DeletedManuscriptDocuments>());
  readonly onDidChangeAvailability = this.status.onDidChangeAvailability;
  readonly onDidChangeAuth = this.status.onDidChangeAuth;
  readonly onDidChangeTree = this.changedTree.event;
  readonly onDidDeleteDocuments = this.deletedDocuments.event;
  readonly store: ManuscriptStore;
  readonly usesMemory: boolean;

  constructor(search: string, configuredStore: string | undefined, createRemote: (status: ManuscriptStatus) => ManuscriptStore) {
    this.usesMemory = new URLSearchParams(search).get('store') === 'memory' || configuredStore === 'memory';
    const store = this.usesMemory ? new InMemoryManuscriptRepository().forUser('window') : createRemote(this.status);
    this.store = {
      listWorks: () => store.listWorks(),
      createWork: input => store.createWork(input),
      getWork: workId => store.getWork(workId),
      getTree: workId => store.getTree(workId),
      createNode: (workId, input, expected) => this.change(workId, expected, store.createNode(workId, input, expected)),
      updateNode: (workId, nodeId, input, expected) => this.change(workId, expected, store.updateNode(workId, nodeId, input, expected)),
      moveNodes: (workId, nodeIds, destination, expected) => this.change(workId, expected, store.moveNodes(workId, nodeIds, destination, expected)),
      deleteNode: async (workId, nodeId, expected) => {
        const result = await this.change(workId, expected, store.deleteNode(workId, nodeId, expected));
        if (result.deletedDocumentIds.length) {
          this.deletedDocuments.fire({ workId, nodeIds: [...result.deletedDocumentIds] });
        }
        return result;
      },
      statDocument: (workId, nodeId) => store.statDocument(workId, nodeId),
      readDocument: (workId, nodeId) => store.readDocument(workId, nodeId),
      writeDocument: (workId, nodeId, content, expected) => store.writeDocument(workId, nodeId, content, expected),
    };
  }

  get availability(): ManuscriptAvailability {
    return this.status.availability;
  }

  dispose(): void {
    this.disposables.dispose();
  }

  private async change<T extends TreeChange>(workId: string, expected: number, operation: Promise<T>): Promise<T> {
    const result = await operation;
    if (result.revision !== expected) {
      this.changedTree.fire(workId);
    }
    return result;
  }
}
