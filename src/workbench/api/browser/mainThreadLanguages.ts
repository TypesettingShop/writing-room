import { ILanguageService } from '../../../editor/common/languages/language.js';
import { MainThreadLanguagesProxy } from '../common/extHost.protocol.languageBasics.js';
import type { MainThreadLanguagesShape } from '../common/extHost.protocol.languageBasics.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';

export class MainThreadLanguages implements MainThreadLanguagesShape {
  constructor(private readonly languages: ILanguageService) {}

  async $getLanguages(): Promise<string[]> {
    return this.languages.getRegisteredLanguageIds();
  }
}

mainThreadCustomers.register('languages', ({ rpc, instantiation }) => {
  const languages = instantiation.invokeFunction(accessor => accessor.get(ILanguageService));
  rpc.set(MainThreadLanguagesProxy, new MainThreadLanguages(languages));
  return {};
});
