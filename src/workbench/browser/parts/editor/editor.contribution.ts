import '../../../../editor/browser/services/modelService.js';
import '../../../../editor/browser/services/codeEditorService.js';
import '../../../services/textmodelResolver/common/textModelResolverService.js';
import '../../../services/untitled/common/untitledTextEditorHandler.js';
import '../../../services/editor/browser/editorService.js';
import './editorCommands.js';
import './editorActions.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { PlaintextLanguageService } from '../../../../editor/common/services/languageService.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { DefaultThemeService, IThemeService } from '../../../../platform/theme/common/themeService.js';
import { UntitledTextEditorInput } from '../../../services/untitled/common/untitledTextEditorInput.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../editor.js';
import type { IEditorPaneRegistry } from '../../editor.js';
import { TextEditorPane } from './textEditor.js';
import { WelcomeEditorInput, WelcomeEditorPane } from './welcomeEditor.js';

// The services other areas meet at start with these implementations. The language and theme members
// register theirs under the same identifiers from modules imported after this one; the last
// registration wins, and nothing is created before the workbench starts.
registerSingleton(ILanguageService, PlaintextLanguageService);
registerSingleton(IThemeService, DefaultThemeService);

const paneRegistry = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!;
paneRegistry.registerEditorPane(
  EditorPaneDescriptor.create(TextEditorPane, TextEditorPane.ID, 'Text Editor'),
  [UntitledTextEditorInput.ID],
);
paneRegistry.registerEditorPane(
  EditorPaneDescriptor.create(WelcomeEditorPane, WelcomeEditorPane.ID, 'Welcome'),
  [WelcomeEditorInput.ID],
);
