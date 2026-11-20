import '../../../../platform/quickinput/browser/quickInputService.js';
import { quickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import './searchActionsSymbol.js';
import { SYMBOLS_PLACEHOLDER, SYMBOLS_PREFIX, SymbolsQuickAccessProvider } from './symbolsQuickAccess.js';

quickAccessRegistry().registerQuickAccessProvider({
  ctor: SymbolsQuickAccessProvider,
  prefix: SYMBOLS_PREFIX,
  placeholder: SYMBOLS_PLACEHOLDER,
  helpEntries: [{ description: 'Go to Symbol in Workspace' }],
});
