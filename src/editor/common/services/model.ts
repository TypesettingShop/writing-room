import type { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../platform/instantiation/common/instantiation.js';
import type { ITextModel } from '../model.js';

export const IModelService = createDecorator<IModelService>('modelService');

/** Creates and finds the text models that hold the text of editors. */
export interface IModelService extends BrandedService {
  /**
   * Creates the model for `resource`. Unlike VS Code this is asynchronous: the editor package is
   * loaded on first use. The caller owns the model and disposes it.
   */
  createModel(value: string, languageId: string, resource: URI): Promise<ITextModel>;
  getModel(resource: URI): ITextModel | null;
}
