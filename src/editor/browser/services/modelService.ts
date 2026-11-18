import type { URI } from '../../../base/common/uri.js';
import { registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import type { ITextModel } from '../../common/model.js';
import { IModelService } from '../../common/services/model.js';
import { loadMonaco } from '../monaco.js';
import type { MonacoNamespace } from '../monaco.js';

/** Keeps text in Monaco's text models, which Monaco editors attach to. */
export class ModelService implements IModelService {
  declare readonly _serviceBrand: undefined;
  private monaco: MonacoNamespace | undefined;

  async createModel(value: string, languageId: string, resource: URI): Promise<ITextModel> {
    const monaco = this.monaco = await loadMonaco();
    return monaco.editor.createModel(value, languageId, monaco.Uri.parse(resource.toString()));
  }

  getModel(resource: URI): ITextModel | null {
    return this.monaco?.editor.getModel(this.monaco.Uri.parse(resource.toString())) ?? null;
  }
}

registerSingleton(IModelService, ModelService);
