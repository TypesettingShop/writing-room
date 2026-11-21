import { afterEach, expect, test, vi } from 'vitest';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ModelService } from '../../../../../editor/browser/services/modelService.js';
import { resetFakeMonaco } from '../../../../../editor/test/browser/fakeMonaco.js';
import type { FakeMonaco } from '../../../../../editor/test/browser/fakeMonaco.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription, IExtensionMessage } from '../../../../../platform/extensions/common/extensions.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { ExtensionMessageCollector, ExtensionsRegistry } from '../../../extensions/common/extensionsRegistry.js';
import type { ExtensionPointContext } from '../../../extensions/common/extensionsRegistry.js';
import type { IExtensionService } from '../../../extensions/common/extensions.js';
import { MonacoLanguageBridge } from '../../browser/monacoLanguages.js';
import { languageContributions, WorkbenchLanguageService } from '../../common/languageService.js';

const monaco = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../../../../../editor/browser/monaco.js', async () => {
  const { FakeMonaco } = await import('../../../../../editor/test/browser/fakeMonaco.js');
  monaco.current = new FakeMonaco();
  return { loadMonaco: async () => monaco.current };
});

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
  resetFakeMonaco(monaco.current as FakeMonaco).dispose();
  host.release();
  await flush();
});

function createBridge(monacoLanguages = new FakeMonacoLanguages()) {
  const languages = disposables.add(new WorkbenchLanguageService());
  const models = disposables.add(new ModelService(languages));
  const activations: string[] = [];
  const extensions = { activateByEvent: async (event: string) => { activations.push(event); } } as unknown as IExtensionService;
  const reads: string[] = [];
  const files = {
    readFile: async (resource: URI) => {
      reads.push(resource.toString());
      return { value: new TextEncoder().encode('{ "comments": { "lineComment": "%%" } }') };
    },
  } as unknown as IFileService;
  Object.assign(monaco.current as FakeMonaco, { languages: monacoLanguages });
  disposables.add(new MonacoLanguageBridge(languages, models, extensions, files));
  return { languages, models, activations, reads, monacoLanguages };
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
  const plain = await models.createModel('', 'plaintext', URI.parse('untitled:Untitled-1'));
  await flush();
  expect(activations).toEqual(['onLanguage:plaintext', 'onLanguage']);

  models.setModelLanguage(plain, 'fixturelang');
  await models.createModel('', 'fixturelang', URI.parse('untitled:Untitled-2'));
  models.setModelLanguage(plain, 'plaintext');
  models.setModelLanguage(plain, 'fixturelang');
  await flush();
  expect(activations.filter(event => event === 'onLanguage:fixturelang')).toHaveLength(1);
  expect(activations.filter(event => event.startsWith('onLanguage:'))).toEqual(['onLanguage:plaintext', 'onLanguage:fixturelang']);
});

test('reads a language configuration when the language is first used, and releases it with the extension', async () => {
  host.apply([fixture()]);
  const { models, reads, monacoLanguages } = createBridge();
  await flush();
  expect(reads).toEqual([]);

  await models.createModel('', 'fixturelang', URI.parse('untitled:Untitled-1'));
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
  await models.createModel('', 'markdown', URI.parse('untitled:Untitled-1'));
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
  const initialLanguages: string[] = [];
  disposables.add(models.onModelAdded(model => initialLanguages.push(model.getLanguageId())));
  const [model, pinned] = await Promise.all([
    models.createModel('', undefined, resource),
    models.createModel('', 'plaintext', URI.parse('vscode-vfs://writing-room/workspace/pinned.js')),
  ]);
  expect(initialLanguages).toEqual(['plaintext', 'plaintext']);
  await flush();
  expect(languages.isRegisteredLanguageId('javascript')).toBe(true);
  expect(model.getLanguageId()).toBe('javascript');
  expect(pinned.getLanguageId()).toBe('plaintext');
});

test('applies and releases a contribution on an already open model', async () => {
  const { models, activations, reads, monacoLanguages } = createBridge();
  const model = await models.createModel('', undefined, URI.parse('vscode-vfs://writing-room/workspace/a.fxl'));
  await flush();
  expect(model.getLanguageId()).toBe('plaintext');
  const changes: string[] = [];
  disposables.add(models.onModelLanguageChanged(event => changes.push(event.newLanguageId)));
  const fake = (monaco.current as FakeMonaco).editor;
  const setModelLanguage = fake.setModelLanguage;
  const registeredBeforeSelection: boolean[] = [];
  const languageChange = vi.spyOn(fake, 'setModelLanguage').mockImplementation((model, language) => {
    registeredBeforeSelection.push(monacoLanguages.getLanguages().some(entry => entry.id === language));
    setModelLanguage(model, language);
  });
  disposables.add(toDisposable(() => { languageChange.mockRestore(); }));

  host.apply([fixture()]);
  await flush();
  expect(registeredBeforeSelection).toEqual([true]);
  expect(model.getLanguageId()).toBe('fixturelang');
  expect(activations.filter(event => event === 'onLanguage:fixturelang')).toHaveLength(1);
  expect(reads).toEqual(['http://127.0.0.1:9/fixtures.lang/language-configuration.json']);
  expect(monacoLanguages.live('fixturelang')).toHaveLength(1);

  host.apply([fixture()]);
  await flush();
  expect(changes).toEqual(['fixturelang']);
  host.apply([]);
  await flush();
  expect(changes).toEqual(['fixturelang', 'plaintext']);
  expect(model.getLanguageId()).toBe('plaintext');
  expect(monacoLanguages.live('fixturelang')).toEqual([]);
});
