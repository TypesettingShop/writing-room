import { afterEach, expect, test } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { MonacoNamespace } from '../../../../../editor/browser/monaco.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import type { IModelLanguageChangedEvent, IModelService } from '../../../../../editor/common/services/model.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../../platform/extensions/common/extensions.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { ExtensionMessageCollector, ExtensionsRegistry } from '../../../extensions/common/extensionsRegistry.js';
import type { ExtensionPointContext } from '../../../extensions/common/extensionsRegistry.js';
import type { IExtensionService } from '../../../extensions/common/extensions.js';
import { MonacoLanguageBridge } from '../../browser/monacoLanguages.js';
import { languageContributions, WorkbenchLanguageService } from '../../common/languageService.js';

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const point = ExtensionsRegistry.getExtensionPoints().find(candidate => candidate.name === 'languages')!;

/** Does what the extension service does with the `languages` point. */
class Host {
  readonly messages: IExtensionMessage[] = [];
  readonly events = new Map<string, Set<string>>();
  private store = new DisposableStore();

  apply(extensions: readonly { id: string; location?: string; languages: unknown }[]): void {
    this.store.dispose();
    this.store = new DisposableStore();
    this.events.clear();
    this.messages.length = 0;
    const context = { addActivationEvent: (id: string, event: string) => {
      const events = this.events.get(id) ?? new Set<string>();
      events.add(event);
      this.events.set(id, events);
    } } as ExtensionPointContext;
    point.accept(extensions.map(extension => ({
      description: {
        identifier: new ExtensionIdentifier(extension.id),
        location: extension.location ?? `http://127.0.0.1:9/${extension.id}/`,
      } as IExtensionDescription,
      value: extension.languages,
      collector: new ExtensionMessageCollector(extension.id, message => this.messages.push(message)),
    })), this.store, context);
  }

  release(): void {
    this.store.dispose();
  }
}

class FakeModel {
  private readonly languageChanged = new Emitter<{ oldLanguage: string; newLanguage: string }>();
  readonly onDidChangeLanguage = this.languageChanged.event;
  private disposed = false;
  constructor(readonly uri: URI, private language: string) {}
  getLanguageId(): string { return this.language; }
  isDisposed(): boolean { return this.disposed; }
  dispose(): void { this.disposed = true; }
  setLanguage(language: string): void {
    const oldLanguage = this.language;
    this.language = language;
    this.languageChanged.fire({ oldLanguage, newLanguage: language });
  }
}

class FakeModelService {
  private readonly added = new Emitter<ITextModel>();
  private readonly removed = new Emitter<ITextModel>();
  private readonly languageChanged = new Emitter<IModelLanguageChangedEvent>();
  readonly onModelAdded = this.added.event;
  readonly onModelRemoved = this.removed.event;
  readonly onModelLanguageChanged = this.languageChanged.event;
  readonly models: FakeModel[] = [];

  add(resource: string, language: string): FakeModel {
    const model = new FakeModel(URI.parse(resource), language);
    this.models.push(model);
    this.added.fire(model as unknown as ITextModel);
    return model;
  }
  getModels(): ITextModel[] { return this.models as unknown as ITextModel[]; }
  getModel(resource: URI): ITextModel | null {
    return (this.models.find(model => model.uri.toString() === resource.toString()) ?? null) as unknown as ITextModel | null;
  }
  setModelLanguage(model: ITextModel, languageId: string): void {
    const fake = model as unknown as FakeModel;
    const oldLanguageId = fake.getLanguageId();
    fake.setLanguage(languageId);
    this.languageChanged.fire({ model, oldLanguageId, newLanguageId: languageId });
  }
}

class FakeMonacoLanguages {
  readonly languages: { id: string; extensions?: string[]; aliases?: string[]; loader?: () => Promise<unknown> }[] = [
    { id: 'plaintext', aliases: ['Plain Text', 'text'], extensions: ['.txt'] },
    { id: 'javascript', aliases: ['JavaScript'], extensions: ['.js'] },
  ];
  readonly configurations: { languageId: string; configuration: unknown; disposed: boolean }[] = [];
  getLanguages() { return this.languages; }
  register(definition: { id: string }) { this.languages.push(definition); }
  setLanguageConfiguration(languageId: string, configuration: unknown) {
    const entry = { languageId, configuration, disposed: false };
    this.configurations.push(entry);
    return toDisposable(() => entry.disposed = true);
  }
  live(languageId: string) { return this.configurations.filter(entry => entry.languageId === languageId && !entry.disposed); }
}

const host = new Host();
const disposables = new DisposableStore();
afterEach(async () => {
  disposables.clear();
  host.release();
  await flush();
});

function createBridge(monacoLanguages = new FakeMonacoLanguages()) {
  const languages = disposables.add(new WorkbenchLanguageService());
  const models = new FakeModelService();
  const activations: string[] = [];
  const extensions = { activateByEvent: async (event: string) => { activations.push(event); } } as unknown as IExtensionService;
  const reads: string[] = [];
  const files = {
    readFile: async (resource: URI) => {
      reads.push(resource.toString());
      return { value: new TextEncoder().encode('{ "comments": { "lineComment": "%%" } }') };
    },
  } as unknown as IFileService;
  const monaco = { languages: monacoLanguages } as unknown as MonacoNamespace;
  class TestBridge extends MonacoLanguageBridge {
    protected override loadMonaco(): Promise<MonacoNamespace> { return Promise.resolve(monaco); }
  }
  const bridge = disposables.add(new TestBridge(languages, models as unknown as IModelService, extensions, files));
  return { bridge, languages, models, activations, reads, monacoLanguages };
}

const fixture = (configuration = './language-configuration.json') => ({
  id: 'fixtures.lang',
  languages: [{ id: 'fixturelang', aliases: ['Fixture Language'], extensions: ['.fxl'], configuration }],
});

test('registers contributed languages, adds onLanguage for those with a configuration, and refuses an escaping path', () => {
  host.apply([fixture(), { id: 'fixtures.bare', languages: [{ id: 'bare' }] }, {
    id: 'fixtures.escape', languages: [{ id: 'escape', configuration: '../other/language-configuration.json' }],
  }]);
  expect(languageContributions.current.map(language => [language.id, language.configuration?.toString()])).toEqual([
    ['fixturelang', 'http://127.0.0.1:9/fixtures.lang/language-configuration.json'],
    ['bare', undefined],
    ['escape', undefined],
  ]);
  expect(host.events.get('fixtures.lang')).toEqual(new Set(['onLanguage:fixturelang']));
  expect(host.events.get('fixtures.bare')).toBeUndefined();
  expect(host.messages).toEqual([expect.objectContaining({ extensionId: 'fixtures.escape', severity: 'warn', path: 'contributes.languages[0].configuration' })]);
});

test('rejects an entry of the wrong shape and keeps the others', () => {
  host.apply([{ id: 'fixtures.mixed', languages: [{ id: 3 }, { id: 'ok', extensions: '.ok' }, { id: 'fine', aliases: ['Fine'] }] }]);
  expect(languageContributions.current.map(language => language.id)).toEqual(['fine']);
  expect(host.messages.map(message => message.path)).toEqual(['contributes.languages[0].id', 'contributes.languages[1].extensions']);
});

test('the service follows contributions, fires only on real changes, and forgets them on removal', async () => {
  const languages = disposables.add(new WorkbenchLanguageService());
  let changes = 0;
  disposables.add(languages.onDidChange(() => changes++));
  host.apply([fixture()]);
  expect(changes).toBe(1);
  expect(languages.isRegisteredLanguageId('fixturelang')).toBe(true);
  expect(languages.guessLanguageIdByFilepathOrFirstLine(URI.parse('vscode-vfs://writing-room/workspace/a.fxl'))).toBe('fixturelang');
  expect(languages.getLanguageName('fixturelang')).toBe('Fixture Language');

  host.apply([fixture()]);
  await flush();
  expect(changes).toBe(1);

  host.release();
  await flush();
  expect(changes).toBe(2);
  expect(languages.isRegisteredLanguageId('fixturelang')).toBe(false);
  expect(languages.getRegisteredLanguageIds()).toEqual(['plaintext']);
});

test('requests each language once: onLanguage fires for the languages models have, never twice', async () => {
  host.apply([fixture()]);
  const { models, activations } = createBridge();
  const plain = models.add('untitled:Untitled-1', 'plaintext');
  await flush();
  expect(activations).toEqual(['onLanguage:plaintext', 'onLanguage']);

  models.setModelLanguage(plain as unknown as ITextModel, 'fixturelang');
  models.add('untitled:Untitled-2', 'fixturelang');
  models.setModelLanguage(plain as unknown as ITextModel, 'plaintext');
  models.setModelLanguage(plain as unknown as ITextModel, 'fixturelang');
  await flush();
  expect(activations.filter(event => event === 'onLanguage:fixturelang')).toHaveLength(1);
  expect(activations.filter(event => event.startsWith('onLanguage:'))).toEqual(['onLanguage:plaintext', 'onLanguage:fixturelang']);
});

test('reads a language configuration when the language is first used, and releases it with the extension', async () => {
  host.apply([fixture()]);
  const { models, reads, monacoLanguages } = createBridge();
  await flush();
  expect(reads).toEqual([]);

  models.add('untitled:Untitled-1', 'fixturelang');
  await flush();
  expect(reads).toEqual(['http://127.0.0.1:9/fixtures.lang/language-configuration.json']);
  expect(monacoLanguages.live('fixturelang')).toEqual([expect.objectContaining({ configuration: { comments: { lineComment: '%%' } } })]);
  // Monaco did not know the contributed id, and cannot create a model of an unknown one.
  expect(monacoLanguages.languages.some(language => language.id === 'fixturelang')).toBe(true);

  host.apply([fixture()]);
  await flush();
  expect(reads).toHaveLength(1);
  expect(monacoLanguages.live('fixturelang')).toHaveLength(1);

  host.release();
  await flush();
  await flush();
  expect(monacoLanguages.live('fixturelang')).toEqual([]);
});

test('a contributed configuration of a built-in language is set after Monaco set its own', async () => {
  const monacoLanguages = new FakeMonacoLanguages();
  let loaded!: () => void;
  monacoLanguages.languages.push({ id: 'markdown', loader: () => new Promise<void>(resolve => loaded = resolve).then(() => {
    // What Monaco's own language registration does on first use: its configuration follows the loader.
    void Promise.resolve().then(() => monacoLanguages.setLanguageConfiguration('markdown', 'built-in'));
  }) });
  host.apply([{ id: 'fixtures.md', languages: [{ id: 'markdown', configuration: './md.json' }] }]);
  const { models } = createBridge(monacoLanguages);
  models.add('untitled:Untitled-1', 'markdown');
  await flush();
  expect(monacoLanguages.configurations).toEqual([]);
  loaded();
  await flush();
  await flush();
  expect(monacoLanguages.configurations.map(entry => entry.configuration))
    .toEqual(['built-in', { comments: { lineComment: '%%' } }]);
});

test('learns the built-in languages once Monaco is there, and gives them to a model that fell back to plain text', async () => {
  const { models, languages } = createBridge();
  const resource = URI.parse('vscode-vfs://writing-room/workspace/app.js');
  expect(languages.guessLanguageIdByFilepathOrFirstLine(resource)).toBeNull();
  const model = models.add(resource.toString(), 'plaintext');
  await flush();
  expect(languages.isRegisteredLanguageId('javascript')).toBe(true);
  expect(model.getLanguageId()).toBe('javascript');
});
