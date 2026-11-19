import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import type { IStatusbarEntry, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';

export const CHANGE_LANGUAGE_MODE_COMMAND_ID = 'workbench.action.editor.changeLanguageMode';
const SELECT_LANGUAGE_MODE = 'Select Language Mode';

/** The text model of the active editor, when it has one: a text editor's input names its resource. */
function activeTextModel(editorService: IEditorService, modelService: IModelService): ITextModel | undefined {
  const resource = editorService.activeEditor?.resource;
  const model = resource ? modelService.getModel(resource) : null;
  return model && !model.isDisposed() ? model : undefined;
}

/**
 * The language of the active text editor in the status bar, as VS Code's `EditorStatus` shows it: the
 * language's name on the right, which opens the language picker. It follows the active editor, its
 * model's language and the set of languages, and goes away while no text editor is active.
 */
export class EditorStatusContribution extends Disposable {
  static readonly ID = 'workbench.contrib.editorStatus';

  private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
  private shown: IStatusbarEntry | undefined;

  constructor(
    @IEditorService private readonly editorService: IEditorService,
    @IModelService private readonly modelService: IModelService,
    @ILanguageService private readonly languageService: ILanguageService,
    @IStatusbarService private readonly statusbarService: IStatusbarService,
  ) {
    super();
    const update = () => this.update();
    this._register(editorService.onDidActiveEditorChange(update));
    this._register(modelService.onModelAdded(update));
    this._register(modelService.onModelRemoved(update));
    this._register(modelService.onModelLanguageChanged(update));
    this._register(languageService.onDidChange(update));
    this.update();
  }

  private update(): void {
    const model = activeTextModel(this.editorService, this.modelService);
    if (!model) {
      this.shown = undefined;
      this.entry.clear();
      return;
    }
    const languageId = model.getLanguageId();
    const text = this.languageService.getLanguageName(languageId) ?? languageId;
    if (this.entry.value && this.shown?.text === text) {
      return;
    }
    this.shown = {
      name: 'Editor Language',
      text,
      ariaLabel: SELECT_LANGUAGE_MODE,
      tooltip: SELECT_LANGUAGE_MODE,
      command: CHANGE_LANGUAGE_MODE_COMMAND_ID,
    };
    if (this.entry.value) {
      this.entry.value.update(this.shown);
    } else {
      this.entry.value = this.statusbarService.addEntry(this.shown, 'status.editor.mode', StatusbarAlignment.RIGHT, 100.1);
    }
  }
}

interface ILanguagePick extends IQuickPickItem {
  readonly languageId: string;
}

/**
 * Picks the language of the active text editor's model. The choice holds for that model only and is not
 * saved, as in VS Code; the model's language change event tells everyone else.
 */
registerAction2(class ChangeLanguageAction extends Action2 {
  constructor() {
    super({
      id: CHANGE_LANGUAGE_MODE_COMMAND_ID,
      title: 'Change Language Mode',
      f1: true,
      keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyM) },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const editorService = accessor.get(IEditorService);
    const modelService = accessor.get(IModelService);
    const languageService = accessor.get(ILanguageService);
    const quickInputService = accessor.get(IQuickInputService);
    const model = activeTextModel(editorService, modelService);
    if (!model) {
      return;
    }
    const current = model.getLanguageId();
    const picks: ILanguagePick[] = languageService.getSortedRegisteredLanguageNames().map(({ languageName, languageId }) => ({
      label: languageName,
      description: languageId === current ? `(${languageId}) - Configured Language` : `(${languageId})`,
      languageId,
    }));
    const pick = await quickInputService.pick(picks, { placeHolder: 'Select Language Mode' });
    if (!pick || model.isDisposed() || pick.languageId === model.getLanguageId()) {
      return;
    }
    modelService.setModelLanguage(model, pick.languageId);
  }
});
