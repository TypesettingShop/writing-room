import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { MonacoNamespace } from '../../../../editor/browser/monaco.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { onDidLoadEditor } from '../../../../platform/theme/browser/editorThemeHook.js';
import { readLanguageConfiguration } from '../../../contrib/codeEditor/common/languageConfigurationExtensionPoint.js';
import { IExtensionService } from '../../extensions/common/extensions.js';
import { WorkbenchLanguageService } from '../common/languageService.js';
import type { ILanguageDefinition } from '../common/languagesRegistry.js';
import { watchRequestedLanguages } from '../common/requestedLanguages.js';

type MonacoLanguageDefinition = ReturnType<MonacoNamespace['languages']['getLanguages']>[number];

/** Monaco's built-in definitions keep the loader of their tokenizer and configuration, which the types leave out. */
export function builtinLoader(definition: MonacoLanguageDefinition | undefined): (() => Promise<unknown>) | undefined {
  const loader = (definition as { loader?: unknown } | undefined)?.loader;
  return typeof loader === 'function' ? loader as () => Promise<unknown> : undefined;
}

const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Waits until Monaco has set up a built-in language, which it does the first time it meets the language:
 * its configuration and tokenizer come from a module the definition's loader imports. A contribution set
 * after this wins over them. Returns at once for a language Monaco does not have built in.
 */
export async function waitForBuiltinLanguage(monaco: MonacoNamespace, languageId: string): Promise<void> {
  const loader = builtinLoader(monaco.languages.getLanguages().find(definition => definition.id === languageId));
  if (!loader) {
    return;
  }
  try {
    await loader();
  } catch {
    return;
  }
  // Monaco registers what the module holds in a promise chain on it; a task later that is done.
  await nextTask();
}

/**
 * Connects the workbench's languages to Monaco once the editor package has loaded, without loading it:
 *
 * - Monaco's built-in languages join the language service, and every contributed language id is
 *   registered with Monaco, which cannot create a model of an id it does not know. Monaco has no way to
 *   unregister a language, so an id stays known to it until the page reloads; its registrations go.
 * - The first time a model of a language exists, the language is "requested": `onLanguage:<id>` and
 *   `onLanguage` activate extensions, and its configuration files are read and given to Monaco. They are
 *   read again, and the old ones released, when the set of files changes (an extension is removed).
 * - For a language Monaco has built in, Monaco sets its own configuration when it first meets the
 *   language; the contributed one is set after that, so it wins where both say something.
 */
export class MonacoLanguageBridge extends Disposable {
  static readonly ID = 'workbench.contrib.monacoLanguages';

  private monaco: MonacoNamespace | undefined;
  private readonly builtinDefinitions = new Map<string, MonacoLanguageDefinition>();
  private readonly requested = new Set<string>();
  private readonly configurations = new Map<string, { signature: string; registrations: DisposableStore }>();

  constructor(
    @ILanguageService private readonly languageService: ILanguageService,
    @IModelService modelService: IModelService,
    @IExtensionService private readonly extensionService: IExtensionService,
    @IFileService private readonly fileService: IFileService,
  ) {
    super();
    this._register(languageService.onDidChange(() => {
      if (this.monaco) {
        this.registerLanguageIds(this.monaco);
        for (const languageId of this.requested) {
          void this.updateConfiguration(languageId);
        }
      }
    }));
    // The loader announces its namespace before returning it to ModelService. The first
    // model can therefore choose its language without a temporary plain-text document.
    this._register(onDidLoadEditor<MonacoNamespace>(monaco => this.connect(monaco)));
    this._register(watchRequestedLanguages(modelService, languageId => this.request(languageId)));
    this._register(toDisposable(() => {
      for (const { registrations } of this.configurations.values()) {
        registrations.dispose();
      }
      this.configurations.clear();
    }));
  }

  private connect(monaco: MonacoNamespace): void {
    if (this.monaco) {
      return;
    }
    for (const definition of monaco.languages.getLanguages()) {
      this.builtinDefinitions.set(definition.id, definition);
    }
    if (this.languageService instanceof WorkbenchLanguageService) {
      this.languageService.setBuiltinLanguages([...this.builtinDefinitions.values()].map((definition): ILanguageDefinition => ({
        id: definition.id,
        aliases: definition.aliases?.filter((alias): alias is string => typeof alias === 'string'),
        extensions: definition.extensions,
        filenames: definition.filenames,
        filenamePatterns: definition.filenamePatterns,
        firstLine: definition.firstLine,
        mimetypes: definition.mimetypes,
      })));
    }
    this.monaco = monaco;
    this.registerLanguageIds(monaco);
    for (const languageId of this.requested) {
      void this.updateConfiguration(languageId);
    }
  }

  private registerLanguageIds(monaco: MonacoNamespace): void {
    const known = new Set(monaco.languages.getLanguages().map(definition => definition.id));
    for (const languageId of this.languageService.getRegisteredLanguageIds()) {
      if (!known.has(languageId)) {
        monaco.languages.register({ id: languageId });
      }
    }
  }

  private request(languageId: string): void {
    this.requested.add(languageId);
    void this.extensionService.activateByEvent(`onLanguage:${languageId}`).catch(() => {});
    void this.extensionService.activateByEvent('onLanguage').catch(() => {});
    void this.updateConfiguration(languageId);
  }

  private async updateConfiguration(languageId: string): Promise<void> {
    const monaco = this.monaco;
    const service = this.languageService;
    if (!monaco || !(service instanceof WorkbenchLanguageService)) {
      return;
    }
    const files = service.getConfigurationFiles(languageId);
    const signature = files.map(file => file.toString()).join('\n');
    const current = this.configurations.get(languageId);
    if (current?.signature === signature) {
      return;
    }
    current?.registrations.dispose();
    const registrations = new DisposableStore();
    this.configurations.set(languageId, { signature, registrations });
    if (!files.length) {
      this.configurations.delete(languageId);
      return;
    }
    const [configurations] = await Promise.all([
      Promise.all(files.map(file => readLanguageConfiguration(this.fileService, languageId, file))),
      waitForBuiltinLanguage(monaco, languageId),
    ]);
    if (registrations.isDisposed || this.configurations.get(languageId)?.registrations !== registrations) {
      return;
    }
    for (const configuration of configurations) {
      try {
        registrations.add(monaco.languages.setLanguageConfiguration(languageId, configuration as never));
      } catch (error) {
        console.warn(`[${languageId}] Could not apply a language configuration:`, error);
      }
    }
  }
}
