import { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { loadMonaco } from '../../../editor/browser/monaco.js';
import type { IMonacoTextModel, MonacoNamespace } from '../../../editor/browser/monaco.js';
import type { LanguageFilter, LanguageSelector } from '../../../editor/common/languageSelector.js';
import { MODEL_SYNC_LIMIT } from '../../../editor/common/model.js';
import { IModelService } from '../../../editor/common/services/model.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import type { OpenOptions } from '../../../platform/opener/common/opener.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { waitForBuiltinLanguage } from '../../services/language/browser/monacoLanguages.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { createMainThreadCompletions } from './mainThreadLanguageFeaturesCompletions.js';
import { createMainThreadEdits } from './mainThreadLanguageFeaturesEdits.js';
import { createMainThreadNavigation, trackProviders } from './mainThreadLanguageFeaturesNavigation.js';
import { ExtHostLanguageFeaturesProxy, MainThreadLanguageFeaturesProxy, mergeHandlers } from '../common/extHost.protocol.languageFeatures.js';
import type {
  CommandDto, ExtHostLanguageFeaturesShape, LanguageConfigurationDto, MainThreadLanguageFeaturesSeamShape, RegExpDto,
} from '../common/extHost.protocol.languageFeatures.js';

/*
 * The workbench side of the language feature seam. Each registration of an extension becomes Monaco
 * registrations, made once the editor package has loaded (the first text model; registering never
 * loads it early) and disposed with `$unregister`, the extension's removal or the host's end. Feature
 * groups add their `$register*` methods in files of their own (`groupFactories`) and build Monaco
 * providers that call the extension host through `request`.
 */

/** Strings and entries a selector may hold; more is refused. */
const MAX_SELECTOR_ENTRIES = 64;
const MAX_SELECTOR_STRING = 1024;

export type MainThreadLanguageFeatureGroupFactory = (seam: MainThreadLanguageFeatures) => object & Partial<IDisposable>;

/** The workbench's feature groups, in the order of their members. Each group file exports its factory. */
const groupFactories: readonly MainThreadLanguageFeatureGroupFactory[] = [createMainThreadCompletions, createMainThreadEdits, createMainThreadNavigation];

function selectorString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > MAX_SELECTOR_STRING) {
    throw new TypeError('Expected a document selector.');
  }
  return value;
}

function selectorFilter(value: unknown): string | LanguageFilter {
  if (typeof value === 'string') {
    return selectorString(value)!;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a document selector.');
  }
  const entry = value as Record<string, unknown>;
  const filter: { -readonly [K in keyof LanguageFilter]: LanguageFilter[K] } = {};
  const language = selectorString(entry.language);
  const scheme = selectorString(entry.scheme);
  const notebookType = selectorString(entry.notebookType);
  if (language) {
    filter.language = language;
  }
  if (scheme) {
    filter.scheme = scheme;
  }
  if (notebookType) {
    filter.notebookType = notebookType;
  }
  if (typeof entry.pattern === 'string') {
    filter.pattern = selectorString(entry.pattern);
  } else if (entry.pattern !== undefined) {
    const pattern = entry.pattern as Record<string, unknown> | null;
    if (!pattern || typeof pattern !== 'object') {
      throw new TypeError('Expected a document selector.');
    }
    filter.pattern = { base: selectorString(pattern.base) ?? '', pattern: selectorString(pattern.pattern) ?? '' };
  }
  return filter;
}

/** A selector the extension host sent, checked; Monaco scores it as VS Code does. */
export function checkSelector(value: unknown): LanguageSelector {
  if (Array.isArray(value)) {
    if (value.length > MAX_SELECTOR_ENTRIES) {
      throw new TypeError('Expected a document selector.');
    }
    return value.map(selectorFilter);
  }
  return selectorFilter(value);
}

/** A regular expression from its source and flags; one that cannot be built is refused. */
export function checkRegExp(value: RegExpDto | undefined): RegExp | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value.source !== 'string' || typeof value.flags !== 'string' || !/^[imsu]*$/.test(value.flags.replace(/[gy]/g, ''))) {
    throw new TypeError('Expected a regular expression.');
  }
  return new RegExp(value.source, value.flags.replace(/[gy]/g, ''));
}

type MonacoLanguageConfiguration = Parameters<MonacoNamespace['languages']['setLanguageConfiguration']>[1];

function stringPair(value: unknown): [string, string] | undefined {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string'
    ? [value[0], value[1]] : undefined;
}

/** A language configuration as Monaco takes it. */
export function toMonacoLanguageConfiguration(dto: LanguageConfigurationDto): MonacoLanguageConfiguration {
  if (!dto || typeof dto !== 'object') {
    throw new TypeError('Expected a language configuration.');
  }
  const result: MonacoLanguageConfiguration = {};
  if (dto.comments && typeof dto.comments === 'object') {
    result.comments = {
      lineComment: typeof dto.comments.lineComment === 'string' ? dto.comments.lineComment : undefined,
      blockComment: stringPair(dto.comments.blockComment),
    };
  }
  if (Array.isArray(dto.brackets)) {
    result.brackets = dto.brackets.map(stringPair).filter((pair): pair is [string, string] => !!pair);
  }
  const wordPattern = checkRegExp(dto.wordPattern);
  if (wordPattern) {
    result.wordPattern = wordPattern;
  }
  if (dto.indentationRules) {
    result.indentationRules = {
      decreaseIndentPattern: checkRegExp(dto.indentationRules.decreaseIndentPattern)!,
      increaseIndentPattern: checkRegExp(dto.indentationRules.increaseIndentPattern)!,
      indentNextLinePattern: checkRegExp(dto.indentationRules.indentNextLinePattern),
      unIndentedLinePattern: checkRegExp(dto.indentationRules.unIndentedLinePattern),
    };
    if (!result.indentationRules.decreaseIndentPattern || !result.indentationRules.increaseIndentPattern) {
      throw new TypeError('Expected indentation patterns.');
    }
  }
  if (Array.isArray(dto.onEnterRules)) {
    result.onEnterRules = dto.onEnterRules.map(rule => {
      const indentAction = rule?.action?.indentAction;
      if (!rule || ![0, 1, 2, 3].includes(indentAction)) {
        throw new TypeError('Expected an enter rule.');
      }
      return {
        beforeText: checkRegExp(rule.beforeText)!,
        afterText: checkRegExp(rule.afterText),
        previousLineText: checkRegExp(rule.previousLineText),
        action: {
          indentAction,
          appendText: typeof rule.action.appendText === 'string' ? rule.action.appendText : undefined,
          removeText: typeof rule.action.removeText === 'number' ? rule.action.removeText : undefined,
        },
      };
    });
  }
  if (Array.isArray(dto.autoClosingPairs)) {
    result.autoClosingPairs = dto.autoClosingPairs
      .filter(pair => typeof pair?.open === 'string' && typeof pair.close === 'string')
      .map(pair => ({
        open: pair.open, close: pair.close,
        notIn: Array.isArray(pair.notIn) ? (pair.notIn as unknown[]).filter((token): token is string => typeof token === 'string') : undefined,
      }));
  }
  return result;
}

interface Registration {
  readonly extension: string;
  disposable?: IDisposable;
}

export interface MainThreadLanguageFeaturesOptions {
  /** Resolves with the editor package once it has loaded. */
  readonly monaco: () => Promise<MonacoNamespace>;
  /** Waits until Monaco has set up a built-in language; the default asks the package. */
  readonly waitForLanguage?: (monaco: MonacoNamespace, languageId: string) => Promise<void>;
  /** Shows the user a warning (a code action that could not be applied); the default logs it. */
  readonly warn?: (message: string) => void;
  /**
   * Follows a document link's target, as the opener service does (web addresses after the user agreed,
   * `command:` links only of the commands `allowCommands` names); the default refuses.
   */
  readonly openLink?: (target: URI, options: OpenOptions) => Promise<boolean>;
}

/** Monaco's `languages.Command`. */
export interface MonacoCommand {
  readonly id: string;
  readonly title: string;
  readonly tooltip?: string;
  readonly arguments?: unknown[];
}

let nextInstance = 0;

export class MainThreadLanguageFeatures implements MainThreadLanguageFeaturesSeamShape, IDisposable {
  private readonly registrations = new Map<number, Registration>();
  private readonly commands = new Map<string, { id: string; registration: IDisposable }>();
  private readonly instance = ++nextInstance;
  private disposed = false;

  constructor(
    readonly proxy: ExtHostLanguageFeaturesShape,
    private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
    private readonly options: MainThreadLanguageFeaturesOptions,
  ) {}

  /** The Monaco registrations alive now, for tests that look for leaks. */
  get registrationCount(): number {
    let count = 0;
    for (const registration of this.registrations.values()) {
      if (registration.disposable) {
        count++;
      }
    }
    return count;
  }

  /** The public identifier of the extension that owns `handle`, for log lines. */
  extensionId(handle: number): string | undefined {
    const registration = this.registrations.get(handle);
    return registration && this.getExtension(registration.extension)?.id;
  }

  /**
   * Registers `handle` of `extension` and makes its Monaco registrations once the editor package has
   * loaded. A handle already in use, or an extension that is not registered, is refused. If the handle
   * goes before `create` finishes, what it made is disposed.
   */
  async register(extension: string, handle: number, create: (monaco: MonacoNamespace) => IDisposable | Promise<IDisposable>): Promise<void> {
    if (this.disposed || typeof extension !== 'string' || !this.getExtension(extension)) {
      throw new Error('The extension is not registered.');
    }
    if (!Number.isSafeInteger(handle) || handle <= 0 || this.registrations.has(handle)) {
      throw new Error('Expected a new provider handle.');
    }
    const registration: Registration = { extension };
    this.registrations.set(handle, registration);
    try {
      const monaco = await this.options.monaco();
      if (this.registrations.get(handle) !== registration) {
        return;
      }
      // Every Monaco provider made is known workbench-wide, for the `vscode.execute*` commands.
      const disposable = await create(trackProviders(monaco, this, handle));
      if (this.registrations.get(handle) !== registration) {
        disposable.dispose();
        return;
      }
      registration.disposable = disposable;
    } catch (error) {
      if (this.registrations.get(handle) === registration) {
        this.registrations.delete(handle);
      }
      throw error;
    }
  }

  /** The extension that owns `handle`, while it is registered. */
  extension(handle: number): HostExtensionDescription | undefined {
    const registration = this.registrations.get(handle);
    return registration && this.getExtension(registration.extension);
  }

  /** Follows a link's target through the workbench's opener; false when there is none or it refused. */
  openLink(target: URI, options: OpenOptions): Promise<boolean> {
    return this.options.openLink ? this.options.openLink(target, options).catch(() => false) : Promise.resolve(false);
  }

  /** Tells the user something a feature could not do. */
  warn(message: string): void {
    if (this.options.warn) {
      this.options.warn(message);
    } else {
      console.warn(message);
    }
  }

  /** Whether `handle` is still registered for `extension`. */
  isRegistered(extension: string, handle: number): boolean {
    return this.registrations.get(handle)?.extension === extension;
  }

  async $unregister(extension: string, handle: number): Promise<void> {
    const registration = this.registrations.get(handle);
    if (registration?.extension === extension) {
      this.registrations.delete(handle);
      registration.disposable?.dispose();
    }
  }

  async $setLanguageConfiguration(extension: string, handle: number, languageId: string, configuration: LanguageConfigurationDto): Promise<void> {
    if (typeof languageId !== 'string' || !languageId || languageId.length > MAX_SELECTOR_STRING) {
      throw new TypeError('Expected a language id.');
    }
    const value = toMonacoLanguageConfiguration(configuration);
    await this.register(extension, handle, async monaco => {
      // A built-in language gets its own configuration the first time Monaco meets it; this one comes after.
      await (this.options.waitForLanguage ?? waitForBuiltinLanguage)(monaco, languageId);
      return monaco.languages.setLanguageConfiguration(languageId, value);
    });
  }

  /**
   * A Monaco command of this host that runs `handler` with the command's arguments. Each name is
   * registered once, the first time it is asked for, and goes with the host.
   */
  monacoCommand(monaco: MonacoNamespace, name: string, handler: (...args: unknown[]) => unknown): string {
    let command = this.commands.get(name);
    if (!command) {
      const id = `_writingRoom.languageFeatures.${this.instance}.${name}`;
      command = { id, registration: monaco.editor.registerCommand(id, (_accessor, ...args: unknown[]) => handler(...args)) };
      this.commands.set(name, command);
    }
    return command.id;
  }

  /**
   * The Monaco command of a provider's command: running it asks the extension host to run the command
   * it kept. A value of another shape gives undefined.
   */
  toMonacoCommand(monaco: MonacoNamespace, dto: CommandDto | undefined): MonacoCommand | undefined {
    if (!dto || typeof dto !== 'object' || !Number.isSafeInteger(dto.ref) || typeof dto.title !== 'string') {
      return undefined;
    }
    const id = this.monacoCommand(monaco, 'run', ref => {
      void this.proxy.$executeProviderCommand(ref as number).catch(error => console.error('A language feature command failed:', error));
    });
    return { id, title: dto.title, tooltip: typeof dto.tooltip === 'string' ? dto.tooltip : undefined, arguments: [dto.ref] };
  }

  /** Disposes every registration of an extension that was removed or failed. */
  remove(extension: string): void {
    for (const [handle, registration] of [...this.registrations]) {
      if (registration.extension === extension) {
        this.registrations.delete(handle);
        registration.disposable?.dispose();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const registration of this.registrations.values()) {
      registration.disposable?.dispose();
    }
    this.registrations.clear();
    for (const { registration } of this.commands.values()) {
      registration.dispose();
    }
    this.commands.clear();
  }
}

/** The workbench URI of a Monaco model. */
export function modelResource(model: IMonacoTextModel): URI {
  const { scheme, authority, path, query, fragment } = model.uri;
  return URI.from({ scheme, authority, path, query, fragment });
}

/** Whether extensions see this model: it is alive and not above the synchronization limit. */
export function isSynchronized(model: IMonacoTextModel): boolean {
  return !model.isDisposed() && model.getValueLength() <= MODEL_SYNC_LIMIT;
}

/**
 * Asks the extension host for a model's feature: undefined without asking when the model is not
 * synchronized, and undefined when the host fails or the request was cancelled before the answer.
 */
export async function request<R>(model: IMonacoTextModel, token: { readonly isCancellationRequested: boolean }, call: (resource: URI) => Promise<R>): Promise<R | undefined> {
  // The model's last change crosses to the extension host in a microtask queued when it happened
  // (`mainThreadDocuments.ts`). Monaco asks right after a keystroke, in the same task: wait for that
  // microtask, so the change arrives before the request and the provider reads the text Monaco has.
  await Promise.resolve();
  if (!isSynchronized(model) || token.isCancellationRequested) {
    return undefined;
  }
  try {
    const result = await call(modelResource(model));
    return token.isCancellationRequested ? undefined : result;
  } catch {
    return undefined;
  }
}

/** Resolves with the editor package once a text model exists, which means it has loaded. */
export function whenMonacoLoaded(models: IModelService, load: () => Promise<MonacoNamespace> = loadMonaco): { promise: Promise<MonacoNamespace>; dispose(): void } {
  if (models.getModels().length) {
    return { promise: load(), dispose: () => {} };
  }
  let listener: IDisposable | undefined;
  const promise = new Promise<void>(resolve => {
    listener = Event.once(models.onModelAdded)(() => resolve());
  }).then(load);
  return { promise, dispose: () => listener?.dispose() };
}

export function createMainThreadLanguageFeatures(
  proxy: ExtHostLanguageFeaturesShape,
  getExtension: (key: string) => HostExtensionDescription | undefined,
  options: MainThreadLanguageFeaturesOptions,
  factories: readonly MainThreadLanguageFeatureGroupFactory[] = groupFactories,
) {
  const seam = new MainThreadLanguageFeatures(proxy, getExtension, options);
  const groups = factories.map(factory => factory(seam));
  return {
    seam,
    groups,
    handlers: mergeHandlers([seam, ...groups]),
    dispose: () => {
      seam.dispose();
      for (const group of groups) {
        group.dispose?.();
      }
    },
  };
}

mainThreadCustomers.register('languageFeatures', ({ rpc, instantiation, getExtension }) => {
  const [models, notifications, opener] = instantiation.invokeFunction(accessor =>
    [accessor.get(IModelService), accessor.get(INotificationService), accessor.get(IOpenerService)] as const);
  const monaco = whenMonacoLoaded(models);
  const features = createMainThreadLanguageFeatures(rpc.getProxy(ExtHostLanguageFeaturesProxy), getExtension, {
    monaco: () => monaco.promise,
    warn: message => notifications.warn(message),
    openLink: (target, options) => opener.open(target, options),
  });
  rpc.set(MainThreadLanguageFeaturesProxy, features.handlers as unknown as MainThreadLanguageFeaturesSeamShape);
  return {
    remove: key => features.seam.remove(key),
    dispose: () => {
      monaco.dispose();
      features.dispose();
    },
  };
});
