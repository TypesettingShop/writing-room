import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IModelService } from '../../../../editor/common/services/model.js';

/**
 * Calls `onRequest` once for each language a model of the model service has: the languages of the models
 * that exist now, then each language a model is created with or changes to. This is VS Code's "a language
 * is requested" moment (`requestRichLanguageFeatures`), when the language's extension activates and its
 * configuration, grammar and snippets are first needed.
 */
export function watchRequestedLanguages(modelService: IModelService, onRequest: (languageId: string) => void): IDisposable {
  const requested = new Set<string>();
  const request = (languageId: string) => {
    if (!requested.has(languageId)) {
      requested.add(languageId);
      onRequest(languageId);
    }
  };
  const store = new DisposableStore();
  store.add(modelService.onModelAdded(model => request(model.getLanguageId())));
  store.add(modelService.onModelLanguageChanged(({ newLanguageId }) => request(newLanguageId)));
  for (const model of modelService.getModels()) {
    request(model.getLanguageId());
  }
  return store;
}
