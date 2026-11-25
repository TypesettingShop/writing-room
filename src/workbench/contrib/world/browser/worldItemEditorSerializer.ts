import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { isManuscriptId, isRecord } from '../../../../platform/manuscript/common/manuscript.js';
import type { IEditorSerializer } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { WorldItemEditorInput, worldItemUri } from './worldItemEditorInput.js';
import { IWorldOpener } from './worldOpener.js';

export class WorldItemEditorSerializer implements IEditorSerializer {
  canSerialize(input: EditorInput): input is WorldItemEditorInput {
    return input instanceof WorldItemEditorInput && input.availability !== 'missing' && !input.model?.deleted;
  }

  serialize(input: EditorInput): string | undefined {
    return this.canSerialize(input) ? JSON.stringify({ workId: input.workId, itemId: input.itemId }) : undefined;
  }

  deserialize(instantiation: IInstantiationService, serialized: string): WorldItemEditorInput | undefined {
    let data: unknown;
    try {
      data = JSON.parse(serialized);
    } catch {
      return undefined;
    }
    if (isRecord(data) && isManuscriptId(data.workId) && isManuscriptId(data.itemId)) {
      const resource = worldItemUri(data.workId, data.itemId);
      return instantiation.invokeFunction(accessor => accessor.get(IWorldOpener).restoreInput(resource));
    }
    return undefined;
  }
}
