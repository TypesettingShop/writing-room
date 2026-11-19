import { afterEach, expect, test, vi } from 'vitest';
import { Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { ModelService } from '../../browser/services/modelService.js';
import type { ILanguageService } from '../../common/languages/language.js';
import { PlaintextLanguageService } from '../../common/services/languageService.js';
import type { ITextModel } from '../../common/model.js';
import { FakeMonaco, resetFakeMonaco } from './fakeMonaco.js';

const monaco = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../../browser/monaco.js', async () => {
  const { FakeMonaco } = await import('./fakeMonaco.js');
  monaco.current = new FakeMonaco();
  return { loadMonaco: async () => monaco.current };
});

function fakeMonaco(): FakeMonaco {
  return monaco.current as FakeMonaco;
}

/** Knows markdown by its extension, on top of plain text. */
class MarkdownLanguageService extends PlaintextLanguageService {
  override guessLanguageIdByFilepathOrFirstLine(resource: URI | null): string | null {
    return resource?.path.endsWith('.md') ? 'markdown' : super.guessLanguageIdByFilepathOrFirstLine(resource);
  }
}

const services: ModelService[] = [];
function createService(languages: ILanguageService = new MarkdownLanguageService()): ModelService {
  const service = new ModelService(languages);
  services.push(service);
  return service;
}

afterEach(() => {
  services.splice(0).forEach(service => service.dispose());
  resetFakeMonaco(fakeMonaco()).dispose();
});

test('fires added after the model is listed and removed before it is disposed, once each', async () => {
  const service = createService();
  const events: string[] = [];
  service.onModelAdded(model => events.push(`added ${model.uri} listed=${service.getModels().includes(model)}`));
  service.onModelRemoved(model => events.push(
    `removed ${model.uri} disposed=${model.isDisposed()} listed=${service.getModels().includes(model)}`));

  const a = await service.createModel('a', 'plaintext', URI.parse('test:a'));
  const b = await service.createModel('b', 'plaintext', URI.parse('test:b'));
  expect(service.getModels()).toEqual([a, b]);
  a.dispose();
  a.dispose();

  expect(events).toEqual([
    'added test:a listed=true',
    'added test:b listed=true',
    'removed test:a disposed=false listed=false',
  ]);
  expect(service.getModels()).toEqual([b]);
  expect(service.getModel(URI.parse('test:a'))).toBeNull();
  expect(service.getModel(URI.parse('test:b'))).toBe(b);
});

test('does not count a model Monaco made outside the service', async () => {
  const service = createService();
  const added = vi.fn();
  service.onModelAdded(added);
  await service.createModel('', 'plaintext', URI.parse('test:own'));
  const foreign = fakeMonaco().editor.createModel('', 'plaintext', URI.parse('test:foreign'));

  expect(service.getModels().map(model => model.uri.toString())).toEqual(['test:own']);
  expect(service.getModel(URI.parse('test:foreign'))).toBeNull();
  expect(() => service.setModelLanguage(foreign, 'markdown')).toThrow(/not a model of the model service/);
  foreign.dispose();
  expect(added).toHaveBeenCalledTimes(1);
});

test('reports a language change with the old and the new language', async () => {
  const service = createService();
  const model = await service.createModel('# Title', 'plaintext', URI.parse('test:doc'));
  const changes: unknown[] = [];
  service.onModelLanguageChanged(({ model: changed, oldLanguageId, newLanguageId }) =>
    changes.push({ model: changed, oldLanguageId, newLanguageId }));

  service.setModelLanguage(model, 'markdown');
  expect(model.getLanguageId()).toBe('markdown');
  expect(changes).toEqual([{ model, oldLanguageId: 'plaintext', newLanguageId: 'markdown' }]);

  // A disposed model's language no longer reaches the service's listeners.
  model.dispose();
  expect(() => service.setModelLanguage(model, 'plaintext')).toThrow();
  expect(changes).toHaveLength(1);
});

test('asks the language service by path when no language is given, with plain text as the fallback', async () => {
  const service = createService();
  const guessed = await service.createModel('', undefined, URI.parse('test:/notes/readme.md'));
  const unknown = await service.createModel('', undefined, URI.parse('test:/notes/data.bin'));
  const given = await service.createModel('', 'json', URI.parse('test:/notes/other.md'));
  expect([guessed, unknown, given].map((model: ITextModel) => model.getLanguageId())).toEqual(['markdown', 'plaintext', 'json']);
});

test('the default language service knows plain text only', () => {
  const languages = new PlaintextLanguageService();
  expect(languages.getRegisteredLanguageIds()).toEqual(['plaintext']);
  expect(languages.isRegisteredLanguageId('markdown')).toBe(false);
  expect(languages.getLanguageName('plaintext')).toBe('Plain Text');
  expect(languages.getLanguageIdByLanguageName('plain text')).toBe('plaintext');
  expect(languages.guessLanguageIdByFilepathOrFirstLine(URI.parse('test:/a/notes.TXT'))).toBe('plaintext');
  expect(languages.guessLanguageIdByFilepathOrFirstLine(URI.parse('test:/a/notes.md'))).toBeNull();
  expect(languages.onDidChange).toBe(Event.None);
});
