import { getKeybindingPlatform } from '../../base/common/keybindings.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { IsLinuxContext, IsMacContext, IsWebContext, IsWindowsContext } from '../../platform/contextkey/common/contextkeys.js';
import { ILanguageService } from '../../editor/common/languages/language.js';
import { IModelService } from '../../editor/common/services/model.js';
import { ActiveEditorContextKeys } from '../common/contextkeys.js';
import { IEditorService } from '../services/editor/common/editorService.js';

/**
 * The workbench-wide keys VS Code's `WorkbenchContextKeysHandler` keeps: the platform, and what the
 * active editor is (read-only, dirty) and shows (the `resource*` keys). They live in the workbench's
 * own scope, so a `when` clause sees them wherever focus is.
 */
export class WorkbenchContextKeysHandler extends Disposable {
  static readonly ID = 'workbench.contrib.contextKeys';

  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @IEditorService private readonly editorService: IEditorService,
    @IModelService modelService: IModelService,
    @ILanguageService languageService: ILanguageService,
  ) {
    super();
    const platform = getKeybindingPlatform(globalThis.navigator?.platform ?? '');
    IsWebContext.bindTo(contextKeyService).set(true);
    IsMacContext.bindTo(contextKeyService).set(platform === 'mac');
    IsLinuxContext.bindTo(contextKeyService).set(platform === 'linux');
    IsWindowsContext.bindTo(contextKeyService).set(platform === 'win');

    // The workbench scope has no parent to hide, so no resource leaves the keys unset.
    const activeEditor = this._register(new ActiveEditorContextKeys(contextKeyService, false, modelService, languageService));
    const update = () => activeEditor.set(this.editorService.activeEditor);
    update();
    this._register(editorService.onDidActiveEditorChange(update));
  }
}
