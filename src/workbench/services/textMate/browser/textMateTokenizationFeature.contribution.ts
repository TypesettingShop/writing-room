import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import '../common/TMGrammars.js';
import { ITextMateTokenizationService, TextMateTokenizationFeature } from './textMateTokenizationFeatureImpl.js';

registerSingleton(ITextMateTokenizationService, TextMateTokenizationFeature);

/** Starts the feature with the workbench, so it sees every model the moment it exists. */
class TextMateTokenizationStartup {
  static readonly ID = 'workbench.contrib.textMateTokenization';
  constructor(@ITextMateTokenizationService _service: ITextMateTokenizationService) {}
}

registerWorkbenchContribution2(TextMateTokenizationStartup.ID, TextMateTokenizationStartup);

/**
 * The TextMate scopes of one line of a language, for tests: `[{ text, scopes }]`, or `null` when the
 * language has no grammar in use. Not in the command palette.
 */
CommandsRegistry.registerCommand('_workbench.textMate.tokenizeLine', (accessor, languageId: unknown, line: unknown) =>
  typeof languageId === 'string' && typeof line === 'string'
    ? accessor.get(ITextMateTokenizationService).tokenizeLine(languageId, line)
    : null);
