import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { EditorStatusContribution } from '../../../browser/parts/editor/editorStatus.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { WorkbenchLanguageService } from '../common/languageService.js';
import { MonacoLanguageBridge } from './monacoLanguages.js';

// The language contributions of extensions (`contributes.languages`), their configuration files, and the
// language mode in the status bar. This module is imported after the editor part, so its language
// service replaces the one that knows only plain text.
registerSingleton(ILanguageService, WorkbenchLanguageService);
registerWorkbenchContribution2(MonacoLanguageBridge.ID, MonacoLanguageBridge);
registerWorkbenchContribution2(EditorStatusContribution.ID, EditorStatusContribution);
