import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { isManuscriptId, isRecord } from '../../../../platform/manuscript/common/manuscript.js';
import type { IEditorSerializer } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { WorldCategoryEditorInput, worldCategoryUri } from './worldCategoryEditorInput.js';
import { IWorldCategoryEditors } from './worldCategoryEditors.js';

export class WorldCategoryEditorSerializer implements IEditorSerializer {
  canSerialize(input: EditorInput): input is WorldCategoryEditorInput {
    return input instanceof WorldCategoryEditorInput && !input.missing;
  }

  serialize(input: EditorInput): string | undefined {
    return this.canSerialize(input) ? JSON.stringify({ workId: input.workId, categoryId: input.categoryId }) : undefined;
  }

  deserialize(instantiation: IInstantiationService, serialized: string): WorldCategoryEditorInput | undefined {
    let data: unknown;
    try {
      data = JSON.parse(serialized);
    } catch {
      return undefined;
    }
    if (isRecord(data) && isManuscriptId(data.workId) && isManuscriptId(data.categoryId)) {
      const resource = worldCategoryUri(data.workId, data.categoryId);
      return instantiation.invokeFunction(accessor => accessor.get(IWorldCategoryEditors).getInput(resource, true));
    }
    return undefined;
  }
}
