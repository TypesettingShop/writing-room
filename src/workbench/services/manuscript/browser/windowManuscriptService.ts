import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { InMemoryManuscriptRepository } from '../../../../platform/manuscript/common/inMemoryManuscriptStore.js';
import type { ManuscriptStore, TreeChange } from '../../../../platform/manuscript/common/manuscriptStore.js';
import type {
  DeletedManuscriptDocuments, IManuscriptService, ManuscriptAuth, ManuscriptAuthChange, ManuscriptAvailability,
} from '../common/manuscriptService.js';
import { HttpManuscriptAuth } from './httpManuscriptAuth.js';

export class ManuscriptStatus extends Disposable {
  private current: ManuscriptAvailability = 'ready';
  private authenticated: boolean | undefined;
  private sessionRevision = 0;
  private readonly changed = this._register(new Emitter<ManuscriptAvailability>());
  private readonly authChanged = this._register(new Emitter<ManuscriptAuthChange>());
  readonly onDidChangeAvailability = this.changed.event;
  readonly onDidChangeAuth = this.authChanged.event;

  get availability(): ManuscriptAvailability {
    return this.current;
  }

  get signedIn(): boolean | undefined {
    return this.authenticated;
  }

  get revision(): number {
    return this.sessionRevision;
  }

  report(availability: ManuscriptAvailability, revision: number): void {
    // A response sent with an earlier session cannot override a later login or logout.
    if (revision !== this.sessionRevision) {
      return;
    }
    const signedIn = availability === 'unavailable' ? this.authenticated : availability === 'ready';
    // A response that signs the window out, or back in (another tab signed in), outdates the requests sent before it.
    if (signedIn !== this.authenticated && (signedIn === false || this.authenticated === false)) {
      this.sessionRevision++;
    }
    this.update(availability, signedIn, 'request');
  }

  setAccount(signedIn: boolean): void {
    this.sessionRevision++;
    this.update(signedIn ? 'ready' : 'signedOut', signedIn, 'account');
  }

  private update(
    availability: ManuscriptAvailability, signedIn: boolean | undefined, reason: ManuscriptAuthChange['reason'],
  ): void {
    const availabilityChanged = this.current !== availability;
    const authChanged = this.authenticated !== signedIn || reason === 'account';
    this.current = availability;
    this.authenticated = signedIn;
    if (availabilityChanged) {
      this.changed.fire(availability);
    }
    if (authChanged && signedIn !== undefined) {
      this.authChanged.fire({ signedIn, reason });
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
  readonly auth: ManuscriptAuth | undefined;

  constructor(search: string, configuredStore: string | undefined, createRemote: (status: ManuscriptStatus) => ManuscriptStore) {
    this.usesMemory = new URLSearchParams(search).get('store') === 'memory' || configuredStore === 'memory';
    this.auth = this.usesMemory ? undefined : new HttpManuscriptAuth(this.status);
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

  get signedIn(): boolean | undefined {
    return this.status.signedIn;
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
