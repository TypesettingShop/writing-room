import type { Event } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../platform/instantiation/common/instantiation.js';
import type { ITextModel } from '../model.js';

export const IModelService = createDecorator<IModelService>('modelService');

export interface IModelLanguageChangedEvent {
  readonly model: ITextModel;
  readonly oldLanguageId: string;
  readonly newLanguageId: string;
}

/**
 * Creates and finds the text models that hold the text of editors. It counts only the models it
 * created: a model Monaco makes for itself is none of its business.
 */
export interface IModelService extends BrandedService {
  /** Fires once per model, after it exists and is in `getModels()`. */
  readonly onModelAdded: Event<ITextModel>;
  /** Fires once per model, before it is disposed and after it left `getModels()`. */
  readonly onModelRemoved: Event<ITextModel>;
  readonly onModelLanguageChanged: Event<IModelLanguageChangedEvent>;

  /**
   * Creates the model for `resource`. Unlike VS Code this is asynchronous: the editor package is
   * loaded on first use. Without a `languageId` the model follows language registrations using
   * its original path and first line, with `plaintext` as the fallback. The caller owns the model
   * and disposes it.
   */
  createModel(value: string, languageId: string | undefined, resource: URI): Promise<ITextModel>;
  getModel(resource: URI): ITextModel | null;
  getModels(): ITextModel[];
  /** Sets an explicit language, ending automatic selection even when the language stays the same. */
  setModelLanguage(model: ITextModel, languageId: string): void;
}
