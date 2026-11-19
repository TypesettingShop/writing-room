import { Disposable } from '../../base/common/lifecycle.js';
import { basename } from '../../base/common/resources.js';
import type { URI } from '../../base/common/uri.js';
import { ILanguageService } from '../../editor/common/languages/language.js';
import { IModelService } from '../../editor/common/services/model.js';
import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';
import type { IContextKey, IContextKeyService } from '../../platform/contextkey/common/contextkey.js';

export const SideBarVisibleContext = new RawContextKey<boolean>('sideBarVisible', false);
export const PanelVisibleContext = new RawContextKey<boolean>('panelVisible', false);
export const ActivityBarVisibleContext = new RawContextKey<boolean>('activityBarVisible', false);
export const StatusBarVisibleContext = new RawContextKey<boolean>('statusBarVisible', false);
export const ActiveViewletContext = new RawContextKey<string>('activeViewlet', '');
export const ActivePanelContext = new RawContextKey<string>('activePanel', '');
export const FocusedViewContext = new RawContextKey<string>('focusedView', '');
export const ViewContext = new RawContextKey<string>('view', '');

// Editor part (the part's scope)
export const ActiveEditorContext = new RawContextKey<string | null>('activeEditor', null);
export const EditorsVisibleContext = new RawContextKey<boolean>('editorIsOpen', false);
export const MultipleEditorGroupsContext = new RawContextKey<boolean>('multipleEditorGroups', false);
export const ActiveEditorGroupEmptyContext = new RawContextKey<boolean>('activeEditorGroupEmpty', false);

// Editor groups (each group's scope)
export const EditorGroupEditorsCountContext = new RawContextKey<number>('groupEditorsCount', 0);
export const ActiveEditorReadonlyContext = new RawContextKey<boolean>('activeEditorIsReadonly', false);
export const ActiveEditorDirtyContext = new RawContextKey<boolean>('activeEditorIsDirty', false);

/**
 * The keys that describe a resource, as VS Code's `ResourceContextKey` binds them: `resource` is the
 * URI as text, `resourceLangId` the language of its open model or else the one its path suggests.
 * The language follows the model while one is open.
 */
export class ResourceContextKey extends Disposable {
  static readonly Resource = new RawContextKey<string>('resource', undefined);
  static readonly Scheme = new RawContextKey<string>('resourceScheme', undefined);
  static readonly Filename = new RawContextKey<string>('resourceFilename', undefined);
  static readonly Dirname = new RawContextKey<string>('resourceDirname', undefined);
  static readonly Path = new RawContextKey<string>('resourcePath', undefined);
  static readonly LangId = new RawContextKey<string>('resourceLangId', undefined);
  static readonly Extension = new RawContextKey<string>('resourceExtname', undefined);
  static readonly HasResource = new RawContextKey<boolean>('resourceSet', false);

  private readonly resourceKey: IContextKey<string>;
  private readonly schemeKey: IContextKey<string>;
  private readonly filenameKey: IContextKey<string>;
  private readonly dirnameKey: IContextKey<string>;
  private readonly pathKey: IContextKey<string>;
  private readonly langIdKey: IContextKey<string>;
  private readonly extensionKey: IContextKey<string>;
  private readonly hasResourceKey: IContextKey<boolean>;
  private value: URI | undefined;

  constructor(
    contextKeyService: IContextKeyService,
    @IModelService private readonly modelService: IModelService,
    @ILanguageService private readonly languageService: ILanguageService,
  ) {
    super();
    this.resourceKey = ResourceContextKey.Resource.bindTo(contextKeyService);
    this.schemeKey = ResourceContextKey.Scheme.bindTo(contextKeyService);
    this.filenameKey = ResourceContextKey.Filename.bindTo(contextKeyService);
    this.dirnameKey = ResourceContextKey.Dirname.bindTo(contextKeyService);
    this.pathKey = ResourceContextKey.Path.bindTo(contextKeyService);
    this.langIdKey = ResourceContextKey.LangId.bindTo(contextKeyService);
    this.extensionKey = ResourceContextKey.Extension.bindTo(contextKeyService);
    this.hasResourceKey = ResourceContextKey.HasResource.bindTo(contextKeyService);
    const refreshLanguage = (uri: { toString(): string }) => {
      if (this.value && uri.toString() === this.value.toString()) {
        this.setLanguage();
      }
    };
    this._register(modelService.onModelAdded(model => refreshLanguage(model.uri)));
    this._register(modelService.onModelRemoved(model => refreshLanguage(model.uri)));
    this._register(modelService.onModelLanguageChanged(({ model }) => refreshLanguage(model.uri)));
    this._register(languageService.onDidChange(() => this.setLanguage()));
  }

  get(): URI | undefined {
    return this.value;
  }

  set(value: URI | null | undefined): void {
    this.value = value ?? undefined;
    if (!this.value) {
      this.reset();
      return;
    }
    const { path } = this.value;
    const filename = basename(this.value);
    const slash = path.lastIndexOf('/');
    const dot = filename.lastIndexOf('.');
    this.resourceKey.set(this.value.toString());
    this.schemeKey.set(this.value.scheme);
    this.filenameKey.set(filename);
    this.dirnameKey.set(slash > 0 ? path.slice(0, slash) : slash === 0 ? '/' : '');
    this.pathKey.set(path);
    this.extensionKey.set(dot > 0 ? filename.slice(dot) : '');
    this.hasResourceKey.set(true);
    this.setLanguage();
  }

  reset(): void {
    this.value = undefined;
    for (const key of [this.resourceKey, this.schemeKey, this.filenameKey, this.dirnameKey, this.pathKey, this.langIdKey, this.extensionKey]) {
      key.reset();
    }
    this.hasResourceKey.set(false);
  }

  private setLanguage(): void {
    const resource = this.value;
    if (!resource) {
      return;
    }
    const language = this.modelService.getModel(resource)?.getLanguageId()
      ?? this.languageService.guessLanguageIdByFilepathOrFirstLine(resource)
      ?? undefined;
    if (language) {
      this.langIdKey.set(language);
    } else {
      this.langIdKey.reset();
    }
  }
}
