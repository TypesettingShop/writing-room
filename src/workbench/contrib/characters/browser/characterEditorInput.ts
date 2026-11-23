import { Emitter } from '../../../../base/common/event.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { CharacterEntry } from '../../../../platform/characters/common/characters.js';
import { isManuscriptId } from '../../../../platform/manuscript/common/manuscript.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { characterTypeIcon } from './characterIcons.js';
import type { CharactersViewState } from './charactersViewState.js';

export const characterScheme = 'character';

export function characterUri(workId: string, nodeId: string): URI {
  return URI.from({ scheme: characterScheme, authority: workId, path: '/' + nodeId });
}

export function characterId(resource: URI, workId: string | undefined): string | undefined {
  const id = resource.path.slice(1);
  if (resource.scheme === characterScheme && isManuscriptId(workId) && resource.authority === workId &&
      resource.path === '/' + id && isManuscriptId(id) && !resource.query && !resource.fragment) {
    return id;
  }
  return undefined;
}

export class CharacterEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.characterInput';

  private readonly changedIcon = this._register(new Emitter<void>());
  override readonly onDidChangeTabIcon = this.changedIcon.event;
  private readonly changedCharacter = this._register(new Emitter<void>());
  readonly onDidChangeCharacter = this.changedCharacter.event;

  readonly resource: URI;
  private _deleted = false;

  constructor(readonly workId: string, private _character: CharacterEntry, state: CharactersViewState) {
    super();
    this.resource = characterUri(workId, _character.id);
    this._register(state.onDidChangeTree(() => {
      const node = state.index?.nodes.get(this.character.id);
      if (node?.kind === 'character') {
        this.updateCharacter(node);
      } else {
        this.markDeleted();
      }
    }));
  }

  get character(): CharacterEntry { return this._character; }
  get deleted(): boolean { return this._deleted; }
  override get typeId(): string { return CharacterEditorInput.ID; }
  override getName(): string { return this.character.title || 'Untitled'; }
  override getTabIcon() { return characterTypeIcon(this.character.type); }
  override isReadonly(): boolean { return true; }

  override matches(other: EditorInput): boolean {
    return other instanceof CharacterEditorInput && isEqual(this.resource, other.resource);
  }

  markDeleted(): void {
    if (!this._deleted) {
      this._deleted = true;
      this.changedCharacter.fire();
    }
  }

  private updateCharacter(node: CharacterEntry): void {
    if (this.deleted) {
      return;
    }
    const old = this.character;
    this._character = node;
    if (old.title !== node.title) {
      this._onDidChangeLabel.fire();
    }
    if (old.type !== node.type) {
      this.changedIcon.fire();
    }
    this.changedCharacter.fire();
  }
}
