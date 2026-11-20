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

const FIRST_LINE_DETECTION_LENGTH_LIMIT = 1_000;

interface LanguageGuess {
  readonly resource: URI;
  readonly firstLine: string;
}

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
  private readonly models = new Map<string, {
    readonly model: IMonacoTextModel;
    readonly listeners: DisposableStore;
    languageGuess: LanguageGuess | undefined;
  }>();

  constructor(@ILanguageService private readonly languageService: ILanguageService) {
    super();
    // Let the bridge register new ids in Monaco first. Setting an unknown id would briefly switch
    // a model to plain text, emitting an extra language change before the id became available.
    this._register(languageService.onDidChange(() => queueMicrotask(() => this.updateModelLanguages())));
  }

  async createModel(value: string, languageId: string | undefined, resource: URI): Promise<ITextModel> {
    const monaco = this.monaco = await loadMonaco();
    // Asked once Monaco is here, so a language registered while it loaded counts.
    let language = languageId;
    let languageGuess: LanguageGuess | undefined;
    if (language === undefined) {
      languageGuess = { resource, firstLine: firstLine(value) };
      language = this.guessLanguage(languageGuess);
    }
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
    this.models.set(key, { model, listeners, languageGuess });
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
    entry.languageGuess = undefined;
    this.monaco.editor.setModelLanguage(entry.model, languageId);
  }

  private guessLanguage({ resource, firstLine }: LanguageGuess): string {
    return this.languageService.guessLanguageIdByFilepathOrFirstLine(resource, firstLine) ?? PLAINTEXT_LANGUAGE_ID;
  }

  private updateModelLanguages(): void {
    const monaco = this.monaco;
    if (!monaco) {
      return;
    }
    for (const { model, languageGuess } of this.models.values()) {
      if (languageGuess) {
        const language = this.guessLanguage(languageGuess);
        if (language !== model.getLanguageId()) {
          monaco.editor.setModelLanguage(model, language);
        }
      }
    }
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
  const prefix = value.slice(0, FIRST_LINE_DETECTION_LENGTH_LIMIT);
  const end = prefix.search(/[\r\n]/);
  return end === -1 ? prefix : prefix.slice(0, end);
}

registerSingleton(IModelService, ModelService);
