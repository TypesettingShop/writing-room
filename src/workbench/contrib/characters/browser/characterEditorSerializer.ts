import { isManuscriptId, isRecord } from '../../../../platform/manuscript/common/manuscript.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IEditorSerializer } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { CharacterEditorInput, characterUri } from './characterEditorInput.js';
import { ICharacterOpener } from './characterOpener.js';

export class CharacterEditorInputSerializer implements IEditorSerializer {
  canSerialize(editor: EditorInput): editor is CharacterEditorInput {
    return editor instanceof CharacterEditorInput && editor.availability !== 'missing' && !editor.model?.deleted;
  }

  serialize(editor: EditorInput): string | undefined {
    if (this.canSerialize(editor)) {
      return JSON.stringify({ workId: editor.workId, characterId: editor.characterId });
    }
    return undefined;
  }

  deserialize(instantiation: IInstantiationService, serialized: string): CharacterEditorInput | undefined {
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      return undefined;
    }
    if (!isRecord(value) || !isManuscriptId(value.workId) || !isManuscriptId(value.characterId)) {
      return undefined;
    }
    const resource = characterUri(value.workId, value.characterId);
    return instantiation.invokeFunction(accessor => accessor.get(ICharacterOpener).restoreInput(resource));
  }
}
