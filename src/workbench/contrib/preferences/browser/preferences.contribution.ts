import { Disposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
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
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
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

/** Opening `vscode-userdata:/User/settings.json` by resource opens the settings editor. */
export class SettingsEditorResolver extends Disposable {
  constructor(
    @IEditorResolverService resolver: IEditorResolverService,
    @ISettingsEditorInputService inputs: ISettingsEditorInputService,
  ) {
    super();
    this._register(resolver.registerEditor(
      SettingsEditorInput.resource.toString(),
      { id: SettingsEditorInput.ID, label: 'Settings (JSON)', priority: RegisteredEditorPriority.builtin },
      {},
      ({ options }) => ({ editor: inputs.getOrCreate(), options }),
    ));
  }
}

registerWorkbenchContribution2('workbench.preferences.settingsEditorResolver', SettingsEditorResolver);

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
