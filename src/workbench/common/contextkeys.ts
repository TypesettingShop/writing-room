import { Disposable, MutableDisposable } from '../../base/common/lifecycle.js';
import { basename } from '../../base/common/resources.js';
import type { URI } from '../../base/common/uri.js';
import { ILanguageService } from '../../editor/common/languages/language.js';
import { IModelService } from '../../editor/common/services/model.js';
import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';
import type { IContextKey, IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { getMarkdownEditorMode, MarkdownEditorModeContext } from '../contrib/markdownEditor/common/markdownEditor.js';
import type { MarkdownEditorMode } from '../contrib/markdownEditor/common/markdownEditor.js';
import type { EditorInput } from './editor/editorInput.js';

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
 * The language follows the model while one is open. Without a resource the keys hold `null`, as in
 * VS Code, so a scope that describes no resource does not show its parent scope's.
 */
export class ResourceContextKey extends Disposable {
  static readonly Resource = new RawContextKey<string | null>('resource', undefined);
  static readonly Scheme = new RawContextKey<string | null>('resourceScheme', undefined);
  static readonly Filename = new RawContextKey<string | null>('resourceFilename', undefined);
  static readonly Dirname = new RawContextKey<string | null>('resourceDirname', undefined);
  static readonly Path = new RawContextKey<string | null>('resourcePath', undefined);
  static readonly LangId = new RawContextKey<string | null>('resourceLangId', undefined);
  static readonly Extension = new RawContextKey<string | null>('resourceExtname', undefined);
  static readonly HasResource = new RawContextKey<boolean>('resourceSet', false);

  private readonly resourceKey: IContextKey<string | null>;
  private readonly schemeKey: IContextKey<string | null>;
  private readonly filenameKey: IContextKey<string | null>;
  private readonly dirnameKey: IContextKey<string | null>;
  private readonly pathKey: IContextKey<string | null>;
  private readonly langIdKey: IContextKey<string | null>;
  private readonly extensionKey: IContextKey<string | null>;
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
    // Any model may be the resource's: Monaco prints a model's URI percent-encoded, so the URIs are
    // not compared as text. Looking the language up again is cheap.
    const refreshLanguage = () => this.setLanguage();
    this._register(modelService.onModelAdded(refreshLanguage));
    this._register(modelService.onModelRemoved(refreshLanguage));
    this._register(modelService.onModelLanguageChanged(refreshLanguage));
    this._register(languageService.onDidChange(refreshLanguage));
  }

  get(): URI | undefined {
    return this.value;
  }

  set(value: URI | null | undefined): void {
    this.value = value ?? undefined;
    const resource = this.value;
    if (!resource) {
      for (const key of [this.resourceKey, this.schemeKey, this.filenameKey, this.dirnameKey, this.pathKey, this.langIdKey, this.extensionKey]) {
        key.set(null);
      }
      this.hasResourceKey.set(false);
      return;
    }
    const { path } = resource;
    const filename = basename(resource);
    const slash = path.lastIndexOf('/');
    const dot = filename.lastIndexOf('.');
    this.resourceKey.set(resource.toString());
    this.schemeKey.set(resource.scheme);
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
    this.langIdKey.set(this.modelService.getModel(resource)?.getLanguageId()
      ?? this.languageService.guessLanguageIdByFilepathOrFirstLine(resource)
      ?? null);
  }
}

/**
 * The keys that describe one active editor in a scope: its resource (`ResourceContextKey`), whether it is
 * read-only, and whether it is dirty, which follows the editor until another is set. The workbench scope
 * and each group's scope keep one each.
 */
export class ActiveEditorContextKeys extends Disposable {
  private readonly resource: ResourceContextKey;
  private readonly readonly: IContextKey<boolean>;
  private readonly mode: IContextKey<MarkdownEditorMode | null>;
  private readonly dirty: IContextKey<boolean>;
  private readonly dirtyListener = this._register(new MutableDisposable());

  /**
   * @param hideParent Without a resource, hold `null` so the parent scope's resource does not show
   * through (a group's scope); otherwise leave the keys unset (the workbench scope, which has no parent).
   */
  constructor(
    contextKeyService: IContextKeyService,
    private readonly hideParent: boolean,
    modelService: IModelService,
    languageService: ILanguageService,
  ) {
    super();
    this.resource = this._register(new ResourceContextKey(contextKeyService, modelService, languageService));
    this.readonly = ActiveEditorReadonlyContext.bindTo(contextKeyService);
    this.mode = MarkdownEditorModeContext.bindTo(contextKeyService);
    this.dirty = ActiveEditorDirtyContext.bindTo(contextKeyService);
  }

  set(editor: EditorInput | undefined): void {
    if (editor?.resource || this.hideParent) {
      this.resource.set(editor?.resource);
    } else {
      this.resource.reset();
    }
    this.mode.set(getMarkdownEditorMode(editor));
    this.readonly.set(editor?.isReadonly() ?? false);
    this.dirty.set(editor?.isDirty() ?? false);
    this.dirtyListener.value = editor?.onDidChangeDirty(() => this.dirty.set(editor.isDirty()));
  }
}
