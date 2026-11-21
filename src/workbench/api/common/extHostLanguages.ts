import type * as vscode from 'vscode';
import { MainThreadLanguagesProxy } from './extHost.protocol.languageBasics.js';
import { extHostApiRegistry, promiseApiMethod } from './extHostApiRegistry.js';

extHostApiRegistry.register('languages', ({ rpc }) => {
  const proxy = rpc.getProxy(MainThreadLanguagesProxy);
  const getLanguages = promiseApiMethod(async (): Promise<string[]> => {
    const languages = await proxy.$getLanguages();
    return Array.isArray(languages) ? languages.filter(language => typeof language === 'string') : [];
  });
  return {
    create: () => ({
      namespaces: {
        languages: {
          getLanguages: getLanguages as typeof vscode.languages.getLanguages,
        } satisfies Pick<typeof vscode.languages, 'getLanguages'>,
      },
    }),
  };
});
