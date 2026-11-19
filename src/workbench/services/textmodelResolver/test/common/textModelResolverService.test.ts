import { beforeEach, expect, test, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { TestModelService } from '../../../../../editor/test/common/testTextModel.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ITextFileService, UntitledTextFileService } from '../../../textfile/common/textfiles.js';
import { UntitledTextEditorInput } from '../../../untitled/common/untitledTextEditorInput.js';
import { IUntitledTextEditorService, UntitledTextEditorService } from '../../../untitled/common/untitledTextEditorService.js';
import { TextModelResolverService } from '../../common/textModelResolverService.js';

let models: TestModelService;
let untitled: UntitledTextEditorService;
let resolver: TextModelResolverService;

beforeEach(() => {
  models = new TestModelService();
  const services = new ServiceCollection([IModelService, models]);
  const instantiation = new InstantiationService(services);
  untitled = instantiation.createInstance(UntitledTextEditorService);
  services.set(IUntitledTextEditorService, untitled);
  services.set(ITextFileService, instantiation.createInstance(UntitledTextFileService));
  resolver = instantiation.createInstance(TextModelResolverService);
});

function registerVirtual(scheme = 'virtual') {
  const provide = vi.fn((resource: URI) => models.createModel(`text of ${resource.path}`, undefined, resource));
  return { provide, registration: resolver.registerTextModelContentProvider(scheme, { provideTextContent: provide }) };
}

test('a provider model is created once, shared, and disposed when the last reference goes', async () => {
  const { provide } = registerVirtual();
  const resource = URI.parse('virtual:/doc');
  const [first, second] = await Promise.all([resolver.createModelReference(resource), resolver.createModelReference(resource)]);
  const model = first.object.textEditorModel;
  expect(second.object.textEditorModel).toBe(model);
  expect(model.getValue()).toBe('text of /doc');
  expect(provide).toHaveBeenCalledTimes(1);

  first.dispose();
  first.dispose();
  await Promise.resolve();
  expect(model.isDisposed()).toBe(false);

  second.dispose();
  await vi.waitFor(() => expect(model.isDisposed()).toBe(true));
  expect(models.getModels()).toEqual([]);

  const again = await resolver.createModelReference(resource);
  expect(again.object.textEditorModel).not.toBe(model);
  expect(provide).toHaveBeenCalledTimes(2);
});

test('a reference taken while the last one is being let go keeps the model', async () => {
  registerVirtual();
  const resource = URI.parse('virtual:/kept');
  const first = await resolver.createModelReference(resource);
  first.dispose();
  const second = await resolver.createModelReference(resource);
  await new Promise(resolve => setTimeout(resolve));
  expect(second.object.textEditorModel).toBe(first.object.textEditorModel);
  expect(second.object.textEditorModel.isDisposed()).toBe(false);
});

test('untitled text stays when its last reference goes: the input owns it', async () => {
  const input = new UntitledTextEditorInput(untitled.create({ initialValue: 'draft' }));
  const reference = await resolver.createModelReference(input.resource);
  const model = reference.object.textEditorModel;
  expect(model.getValue()).toBe('draft');
  expect(model).toBe(input.model.textEditorModel);

  reference.dispose();
  await new Promise(resolve => setTimeout(resolve));
  expect(model.isDisposed()).toBe(false);
  expect(input.model.isDisposed()).toBe(false);

  // Once the input disposes it, the next reference does not get the dead model back.
  input.dispose();
  await expect(resolver.createModelReference(input.resource)).rejects.toThrow(/no such untitled text/);
});

test('a model someone else created is lent, never disposed', async () => {
  const owned = await models.createModel('{}', 'json', URI.parse('vscode-userdata:/User/settings.json'));
  const reference = await resolver.createModelReference(owned.uri as URI);
  expect(reference.object.textEditorModel).toBe(owned);
  reference.dispose();
  await new Promise(resolve => setTimeout(resolve));
  expect(owned.isDisposed()).toBe(false);
});

test('rejects a scheme nobody provides, at once, and tries again after a failure', async () => {
  const resource = URI.parse('nowhere:/x');
  expect(resolver.canHandleResource(resource)).toBe(false);
  await expect(resolver.createModelReference(resource)).rejects.toThrow(/no text model content provider for 'nowhere'/);

  const { registration } = registerVirtual('nowhere');
  expect(resolver.canHandleResource(resource)).toBe(true);
  const reference = await resolver.createModelReference(resource);
  expect(reference.object.textEditorModel.getValue()).toBe('text of /x');
  registration.dispose();
  expect(resolver.canHandleResource(URI.parse('nowhere:/y'))).toBe(false);
});

test('asks the latest provider first and falls back to older ones', async () => {
  registerVirtual();
  resolver.registerTextModelContentProvider('virtual', { provideTextContent: () => null });
  const reference = await resolver.createModelReference(URI.parse('virtual:/fallback'));
  expect(reference.object.textEditorModel.getValue()).toBe('text of /fallback');
});

test('letting go of a long-lived model stops watching it, so taking and dropping references adds no listeners', async () => {
  let watching = 0;
  const removed = models.onModelRemoved;
  Object.assign(models, {
    onModelRemoved: ((listener, thisArgs, disposables) => {
      watching++;
      const subscription = removed(listener, thisArgs, disposables);
      return { dispose: () => { watching--; subscription.dispose(); } };
    }) satisfies typeof removed,
  });
  const input = new UntitledTextEditorInput(untitled.create({ initialValue: 'draft' }));
  const before = watching;
  for (let cycle = 0; cycle < 3; cycle++) {
    const reference = await resolver.createModelReference(input.resource);
    reference.dispose();
    await new Promise(resolve => setTimeout(resolve));
  }
  expect(watching).toBe(before);
  input.dispose();
});
