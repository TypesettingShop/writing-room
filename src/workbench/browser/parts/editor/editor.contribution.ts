import '../../../../editor/browser/services/modelService.js';
import '../../../services/untitled/common/untitledTextEditorService.js';
import '../../../services/editor/browser/editorService.js';
import './editorCommands.js';
import './editorActions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { UntitledTextEditorInput } from '../../../services/untitled/common/untitledTextEditorInput.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../editor.js';
import type { IEditorPaneRegistry } from '../../editor.js';
import { TextEditorPane } from './textEditor.js';
import { WelcomeEditorInput, WelcomeEditorPane, WelcomePageContribution } from './welcomeEditor.js';

const paneRegistry = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!;
paneRegistry.registerEditorPane(
  EditorPaneDescriptor.create(TextEditorPane, TextEditorPane.ID, 'Text Editor'),
  [UntitledTextEditorInput.ID],
);
paneRegistry.registerEditorPane(
  EditorPaneDescriptor.create(WelcomeEditorPane, WelcomeEditorPane.ID, 'Welcome'),
  [WelcomeEditorInput.ID],
);

registerWorkbenchContribution2(WelcomePageContribution.ID, WelcomePageContribution);
