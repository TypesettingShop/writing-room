import { Disposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { configurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import {
  MARKDOWN_EDITOR_FOOTNOTES_PANEL, MARKDOWN_EDITOR_SECTION_NUMBERS, MarkdownEditorModeContext,
} from '../common/markdownEditor.js';

configurationRegistry.registerConfiguration({
  id: 'markdownEditor',
  properties: {
    [MARKDOWN_EDITOR_SECTION_NUMBERS]: {
      type: 'boolean',
      default: false,
      description: 'Shows section numbers before the first paragraph of each section in the Manuscript Editor.',
    },
    [MARKDOWN_EDITOR_FOOTNOTES_PANEL]: {
      type: 'boolean',
      default: true,
      description: 'Shows footnotes at the bottom of the Manuscript Editor when the document contains them.',
    },
  },
});

const visualMode = MarkdownEditorModeContext.isEqualTo('wysiwyg');
const sectionNumbers = new RawContextKey<boolean>(MARKDOWN_EDITOR_SECTION_NUMBERS, false);

class MarkdownEditorPresentationContribution extends Disposable {
  constructor(
    @IContextKeyService contextKeys: IContextKeyService,
    @IConfigurationService configuration: IConfigurationService,
  ) {
    super();
    const visible = sectionNumbers.bindTo(contextKeys);
    const update = () => visible.set(configuration.getValue(MARKDOWN_EDITOR_SECTION_NUMBERS) === true);
    update();
    this._register(configuration.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(MARKDOWN_EDITOR_SECTION_NUMBERS)) update();
    }));
  }
}

registerWorkbenchContribution2('workbench.contrib.markdownEditorPresentation', MarkdownEditorPresentationContribution);
const toggleSectionNumbers = 'markdownEditor.toggleSectionNumbers';

registerAction2(class ToggleSectionNumbers extends Action2 {
  constructor() {
    super({
      id: toggleSectionNumbers, title: 'Toggle Section Numbers', category: 'Markdown', f1: true,
      precondition: visualMode, toggled: sectionNumbers.isEqualTo(true),
    });
  }

  override run(accessor: ServicesAccessor): Promise<void> {
    const configuration = accessor.get(IConfigurationService);
    return configuration.updateValue(MARKDOWN_EDITOR_SECTION_NUMBERS, configuration.getValue(MARKDOWN_EDITOR_SECTION_NUMBERS) !== true);
  }
});

MenuRegistry.appendMenuItem(MenuId.MenubarAppearanceMenu, {
  group: '2_workbench_layout', order: 6, when: visualMode,
  command: { id: toggleSectionNumbers, title: 'Section Numbers', toggled: sectionNumbers.isEqualTo(true) },
});

registerAction2(class ToggleFootnotesPanel extends Action2 {
  constructor() {
    super({
      id: 'markdownEditor.toggleFootnotesPanel', title: 'Toggle Footnotes Panel', category: 'Markdown',
      f1: true, precondition: visualMode,
    });
  }

  override run(accessor: ServicesAccessor): Promise<void> {
    const configuration = accessor.get(IConfigurationService);
    return configuration.updateValue(MARKDOWN_EDITOR_FOOTNOTES_PANEL, configuration.getValue(MARKDOWN_EDITOR_FOOTNOTES_PANEL) === false);
  }
});
