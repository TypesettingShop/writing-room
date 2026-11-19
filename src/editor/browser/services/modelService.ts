import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import { registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { ILanguageService, PLAINTEXT_LANGUAGE_ID } from '../../common/languages/language.js';
import type { ITextModel } from '../../common/model.js';
import { IModelService } from '../../common/services/model.js';
import type { IModelLanguageChangedEvent } from '../../common/services/model.js';
import { loadMonaco } from '../monaco.js';
import type { IMonacoTextModel, MonacoNamespace } from '../monaco.js';

/** Keeps text in Monaco's text models, which Monaco editors attach to. */
export class ModelService extends Disposable implements IModelService {
  declare readonly _serviceBrand: undefined;

  private readonly _onModelAdded = this._register(new Emitter<ITextModel>());
  readonly onModelAdded = this._onModelAdded.event;
  private readonly _onModelRemoved = this._register(new Emitter<ITextModel>());
  readonly onModelRemoved = this._onModelRemoved.event;
  private readonly _onModelLanguageChanged = this._register(new Emitter<IModelLanguageChangedEvent>());
  readonly onModelLanguageChanged = this._onModelLanguageChanged.event;

  private monaco: MonacoNamespace | undefined;
  /** The models this service created and that are not disposed, by resource. */
  private readonly models = new Map<string, { readonly model: IMonacoTextModel; readonly listeners: DisposableStore }>();

  constructor(@ILanguageService private readonly languageService: ILanguageService) {
    super();
  }

  async createModel(value: string, languageId: string | undefined, resource: URI): Promise<ITextModel> {
    const monaco = this.monaco = await loadMonaco();
    // Asked once Monaco is here, so a language registered while it loaded counts.
    const language = languageId ?? this.languageService.guessLanguageIdByFilepathOrFirstLine(resource, firstLine(value))
      ?? PLAINTEXT_LANGUAGE_ID;
    const model = monaco.editor.createModel(value, language, monaco.Uri.parse(resource.toString()));
    const key = resource.toString();
    const listeners = new DisposableStore();
    listeners.add(model.onDidChangeLanguage(({ oldLanguage, newLanguage }) =>
      this._onModelLanguageChanged.fire({ model, oldLanguageId: oldLanguage, newLanguageId: newLanguage })));
    listeners.add(model.onWillDispose(() => {
      // Out of the list first, so a listener of the event no longer finds it.
      if (this.models.get(key)?.model === model) {
        this.models.delete(key);
      }
      listeners.dispose();
      this._onModelRemoved.fire(model);
    }));
    this.models.set(key, { model, listeners });
    this._onModelAdded.fire(model);
    return model;
  }

  getModel(resource: URI): ITextModel | null {
    return this.models.get(resource.toString())?.model ?? null;
  }

  getModels(): ITextModel[] {
    return [...this.models.values()].map(entry => entry.model);
  }

  setModelLanguage(model: ITextModel, languageId: string): void {
    // Found by identity: Monaco prints `model.uri` percent-encoded (`my%20notes.md`), unlike the
    // workbench URI the map is keyed by.
    const entry = [...this.models.values()].find(candidate => candidate.model === model);
    if (!this.monaco || !entry) {
      throw new Error(`${model.uri} is not a model of the model service.`);
    }
    this.monaco.editor.setModelLanguage(entry.model, languageId);
  }

  override dispose(): void {
    for (const { listeners } of this.models.values()) {
      listeners.dispose();
    }
    this.models.clear();
    super.dispose();
  }
}

function firstLine(value: string): string {
  const end = value.search(/\r\n|\r|\n/);
  return end === -1 ? value : value.slice(0, end);
}

registerSingleton(IModelService, ModelService);
