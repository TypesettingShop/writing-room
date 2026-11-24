import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { CharactersStore, CharacterTemplateSnapshot } from '../../../../platform/characters/common/charactersStore.js';
import { InMemoryCharactersRepository } from '../../../../platform/characters/common/inMemoryCharactersStore.js';
import type { WindowManuscriptService } from '../../manuscript/browser/windowManuscriptService.js';
import type { DeletedCharacters, ICharactersService, WindowCharactersStore } from '../common/charactersService.js';
import { HttpCharactersStore } from './httpCharactersStore.js';

interface TemplateState {
  latest: CharacterTemplateSnapshot;
  announcedRevision?: number;
  notifying: boolean;
}

export class WindowCharactersService implements ICharactersService {
  declare readonly _serviceBrand: undefined;
  private readonly disposables = new DisposableStore();
  private readonly changedTree = this.disposables.add(new Emitter<string>());
  private readonly changedTemplate = this.disposables.add(new Emitter<string>());
  private readonly templates = new Map<string, TemplateState>();
  private readonly deletedCharacters = this.disposables.add(new Emitter<DeletedCharacters>());
  readonly onDidChangeTree = this.changedTree.event;
  readonly onDidChangeTemplate = this.changedTemplate.event;
  readonly onDidDeleteCharacters = this.deletedCharacters.event;
  readonly usesMemory: boolean;
  readonly store: WindowCharactersStore;

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
      getTemplate: async workId => {
        const current = this.templates.get(workId);
        if (current?.notifying) {
          return structuredClone(current.latest);
        }
        const template = await store.getTemplate(workId);
        const state = this.rememberTemplate(workId, template);
        // Initialize from the first read. A later ordinary read (e.g. opening the template tab)
        // must not consume the change still owed to the open cards at their next save.
        state.announcedRevision ??= state.latest.revision;
        return template.revision === state.latest.revision ? template : structuredClone(state.latest);
      },
      checkTemplateChanges: async workId => {
        try {
          const template = await store.getTemplate(workId);
          this.announceTemplate(workId, template);
        } catch {
          // A failed template check leaves the card's current form and write independent.
        }
      },
      putTemplate: async (workId, fields, expected) => {
        const template = await store.putTemplate(workId, fields, expected);
        if (template.revision !== expected) {
          this.announceTemplate(workId, template);
        }
        return template;
      },
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

  private announceTemplate(workId: string, template: CharacterTemplateSnapshot): void {
    const state = this.rememberTemplate(workId, template);
    if (state.latest.revision <= (state.announcedRevision ?? -1)) {
      return;
    }
    state.announcedRevision = state.latest.revision;
    // The listeners reread synchronously in the event callback. Give them this response so a
    // failed follow-up request cannot leave a card behind a revision we already announced.
    state.notifying = true;
    try {
      this.changedTemplate.fire(workId);
    } finally {
      state.notifying = false;
    }
  }

  private rememberTemplate(workId: string, template: CharacterTemplateSnapshot): TemplateState {
    let state = this.templates.get(workId);
    if (!state) {
      state = { latest: structuredClone(template), notifying: false };
      this.templates.set(workId, state);
    } else if (template.revision > state.latest.revision) {
      state.latest = structuredClone(template);
    }
    return state;
  }

  private async change<T extends { revision: number }>(workId: string, expected: number, operation: Promise<T>): Promise<T> {
    const result = await operation;
    if (result.revision !== expected) {
      this.changedTree.fire(workId);
    }
    return result;
  }
}
