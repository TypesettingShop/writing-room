import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../../browser/editor.js';
import { closeEmptyGroupsSetting, setEditorPartOptionsProvider } from '../../../browser/parts/editor/editor.js';
import { TextEditorPane } from '../../../browser/parts/editor/textEditor.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import type { IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import '../../../services/configuration/browser/configurationService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISettingsEditorInputService, SettingsEditorInput } from './settingsEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.registerEditorPane(
  EditorPaneDescriptor.create(TextEditorPane, TextEditorPane.ID, 'Text Editor'),
  [SettingsEditorInput.ID],
);

class SettingsEditorSerializer implements IEditorSerializer {
  canSerialize(editor: EditorInput): boolean { return editor instanceof SettingsEditorInput; }
  serialize(editor: EditorInput): string | undefined {
    if (editor instanceof SettingsEditorInput) {
      const resource = SettingsEditorInput.resource.toString();
      const draft = editor.draft;
      return draft === undefined ? resource : resource + '\n' + draft;
    }
    return undefined;
  }

  deserialize(instantiation: IInstantiationService, text: string): EditorInput | undefined {
    const separator = text.indexOf('\n');
    const resource = separator === -1 ? text : text.slice(0, separator);
    if (resource === SettingsEditorInput.resource.toString()) {
      const draft = separator === -1 ? undefined : text.slice(separator + 1);
      return instantiation.invokeFunction(accessor => accessor.get(ISettingsEditorInputService).getOrCreate(draft));
    }
    return undefined;
  }
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!.registerEditorSerializer(
  SettingsEditorInput.ID, SettingsEditorSerializer,
);

class PreferencesEditorOptions extends Disposable {
  constructor(@IConfigurationService configuration: IConfigurationService) {
    super();
    this._register(setEditorPartOptionsProvider(() => ({
      closeEmptyGroups: configuration.getValue<boolean>(closeEmptyGroupsSetting),
    })));
  }
}

registerWorkbenchContribution2('workbench.preferences.editorOptions', PreferencesEditorOptions);

registerAction2(class OpenUserSettingsJson extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.openSettingsJson', title: 'Open User Settings (JSON)', category: 'Preferences', f1: true,
      menu: { id: MenuId.MenubarPreferencesMenu, group: '1_settings' },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const input = accessor.get(ISettingsEditorInputService).getOrCreate();
    const editors = accessor.get(IEditorService);
    const { activeGroup, groups } = accessor.get(IEditorGroupsService);
    const group = activeGroup.contains(input) ? activeGroup : groups.find(candidate => candidate.contains(input));
    await editors.openEditor(input, undefined, group);
  }
});

registerAction2(class SaveFile extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.files.save', title: 'Save', f1: true,
      keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyS, weight: KeybindingWeight.WorkbenchContrib },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const editor = accessor.get(IEditorService).activeEditor;
    if (!(editor instanceof SettingsEditorInput)) {
      return;
    }
    const quickInput = accessor.get(IQuickInputService);
    try {
      editor.save();
    } catch (error) {
      // A warning, not an error: the dialog below already tells the user, and the draft stays open.
      console.warn('Could not save settings.json.', error);
      await quickInput.pick([{ label: 'OK', detail: 'Your changes are still open. Free browser storage or allow this site to store data, then try again.' }],
        { title: 'Could not save settings.json' });
    }
  }
});
