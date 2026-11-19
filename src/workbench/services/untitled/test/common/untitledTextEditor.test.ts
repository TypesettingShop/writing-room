import { beforeEach, describe, expect, test, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { TestModelService } from '../../../../../editor/test/common/testTextModel.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { UntitledTextEditorInputSerializer } from '../../common/untitledTextEditorHandler.js';
import { UntitledTextEditorInput } from '../../common/untitledTextEditorInput.js';
import { IUntitledTextEditorService, UntitledTextEditorService } from '../../common/untitledTextEditorService.js';

let models: TestModelService;
let service: UntitledTextEditorService;

beforeEach(() => {
  models = new TestModelService();
  const instantiation = new InstantiationService(new ServiceCollection([IModelService, models]));
  service = instantiation.createInstance(UntitledTextEditorService);
});

function names(): string[] {
  return [1, 2, 3, 4, 5].map(n => `untitled:Untitled-${n}`).filter(name => service.get(URI.parse(name)));
}

test('names untitled editors with the lowest free number and reuses a returned one', () => {
  const first = service.create();
  const second = service.create();
  const third = service.create();
  expect([first, second, third].map(model => model.resource.toString()))
    .toEqual(['untitled:Untitled-1', 'untitled:Untitled-2', 'untitled:Untitled-3']);
  expect(second.name).toBe('Untitled-2');

  second.dispose();
  expect(names()).toEqual(['untitled:Untitled-1', 'untitled:Untitled-3']);
  expect(service.create().resource.toString()).toBe('untitled:Untitled-2');
  expect(service.create().resource.toString()).toBe('untitled:Untitled-4');
});

test('gives the number back when the input that owns the model is disposed', () => {
  const input = new UntitledTextEditorInput(service.create());
  service.create();
  input.dispose();
  expect(input.model.isDisposed()).toBe(true);
  expect(service.create().resource.toString()).toBe('untitled:Untitled-1');
});

test('matches the same untitled resource and nothing else', () => {
  const first = new UntitledTextEditorInput(service.create());
  const second = new UntitledTextEditorInput(service.create());
  const sameResource = new UntitledTextEditorInput(first.model);

  expect(first.matches(first)).toBe(true);
  expect(first.matches(sameResource)).toBe(true);
  expect(first.matches(second)).toBe(false);
  expect(second.matches(first)).toBe(false);
  expect(first.typeId).toBe('workbench.editors.untitledEditorInput');
  expect(first.getName()).toBe('Untitled-1');
});

test('is dirty exactly while the text is not empty and says so when that changes', async () => {
  const input = new UntitledTextEditorInput(service.create());
  const onDirty = vi.fn();
  input.onDidChangeDirty(onDirty);
  expect(input.isDirty()).toBe(false);

  const model = (await input.resolve()).textEditorModel!;
  expect(model.getValue()).toBe('');
  expect(input.isDirty()).toBe(false);
  expect(onDirty).not.toHaveBeenCalled();

  model.setValue('text');
  expect(input.isDirty()).toBe(true);
  expect(onDirty).toHaveBeenCalledTimes(1);
  model.setValue('more text');
  expect(onDirty).toHaveBeenCalledTimes(1);

  model.setValue('');
  expect(input.isDirty()).toBe(false);
  expect(onDirty).toHaveBeenCalledTimes(2);
});

test('starts dirty with initial text and creates one plain text model however often it resolves', async () => {
  const input = new UntitledTextEditorInput(service.create({ initialValue: 'hello' }));
  expect(input.isDirty()).toBe(true);
  const [first, second] = await Promise.all([input.resolve(), input.resolve()]);
  expect(first).toBe(second);
  expect(models.created).toHaveLength(1);
  expect(models.created[0].getValue()).toBe('hello');
  expect(models.created[0].languageId).toBe('plaintext');
  expect(models.created[0].uri.toString()).toBe('untitled:Untitled-1');
});

test('disposes the text model with the input, and a model that arrives after disposal too', async () => {
  const input = new UntitledTextEditorInput(service.create());
  const model = (await input.resolve()).textEditorModel!;
  input.dispose();
  expect(model.isDisposed()).toBe(true);
  expect(input.model.textEditorModel).toBeNull();

  let open!: () => void;
  models.gate = new Promise(resolve => open = resolve);
  const late = new UntitledTextEditorInput(service.create());
  const resolving = late.resolve();
  late.dispose();
  open();
  await resolving;
  expect(models.created.at(-1)!.isDisposed()).toBe(true);
  await expect(late.resolve()).rejects.toThrow('disposed');
});

test('tries again after a model could not be created', async () => {
  const input = new UntitledTextEditorInput(service.create());
  const create = vi.spyOn(models, 'createModel').mockRejectedValueOnce(new Error('offline'));
  await expect(input.resolve()).rejects.toThrow('offline');
  await expect(input.resolve()).resolves.toBe(input.model);
  expect(create).toHaveBeenCalledTimes(2);
});

test('keeps the number of a model disposed while its text model is on its way until that one is gone', async () => {
  let open!: () => void;
  models.gate = new Promise(resolve => open = resolve);
  const closed = new UntitledTextEditorInput(service.create());
  const closing = closed.resolve();
  closed.dispose();
  const next = new UntitledTextEditorInput(service.create());
  expect(next.resource.toString()).toBe('untitled:Untitled-2');
  const opening = next.resolve();
  open();
  await closing;
  await expect(opening).resolves.toBe(next.model);
  expect(service.create().resource.toString()).toBe('untitled:Untitled-1');
});

describe('the untitled editor serializer', () => {
  function restoreFrom(value: string) {
    const fresh = new TestModelService();
    const instantiation = new InstantiationService(new ServiceCollection([IModelService, fresh]));
    const restoredService = instantiation.createInstance(UntitledTextEditorService);
    const withService = new InstantiationService(new ServiceCollection([IUntitledTextEditorService, restoredService]));
    const input = new UntitledTextEditorInputSerializer().deserialize(withService, value);
    return { input: input as UntitledTextEditorInput | undefined, models: fresh };
  }

  test('keeps the language a tab was switched to across a reload', async () => {
    const input = new UntitledTextEditorInput(service.create({ initialValue: '# notes' }));
    await input.resolve();
    input.model.setLanguageId('markdown');
    const value = new UntitledTextEditorInputSerializer().serialize(input)!;

    const { input: restored, models: restoredModels } = restoreFrom(value);
    await restored!.resolve();
    expect(restored!.model.getValue()).toBe('# notes');
    expect(restoredModels.created[0].languageId).toBe('markdown');
  });

  test('still reads the v0.1.0 form without a language, and drops a language that cannot be one', async () => {
    const withoutLanguage = new UntitledTextEditorInputSerializer().serialize(new UntitledTextEditorInput(service.create({ initialValue: 'old' })))!;
    // Plain text is saved as v0.1.0 saved every untitled tab.
    expect(withoutLanguage.split('\n')).toHaveLength(2);
    const old = restoreFrom(withoutLanguage);
    await old.input!.resolve();
    expect(old.input!.model.getValue()).toBe('old');
    expect(old.models.created[0].languageId).toBe('plaintext');

    const broken = restoreFrom(withoutLanguage + '\nmark down');
    await broken.input!.resolve();
    expect(broken.input!.model.getValue()).toBe('old');
    expect(broken.models.created[0].languageId).toBe('plaintext');
  });
});
