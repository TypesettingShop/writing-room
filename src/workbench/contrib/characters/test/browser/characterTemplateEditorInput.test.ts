import { afterEach, expect, test, vi } from 'vitest';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { CharacterStoreError } from '../../../../../platform/characters/common/characters.js';
import type { CharacterTemplate } from '../../../../../platform/characters/common/characterFields.js';
import type { CharacterTemplateSnapshot } from '../../../../../platform/characters/common/charactersStore.js';
import { getDefaultCharacterTemplate } from '../../../../../platform/characters/common/defaultCharacterTemplate.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { ConfirmResult } from '../../../../common/editor/editorInput.js';
import { ICharactersService } from '../../../../services/characters/common/charactersService.js';
import { IFileDialogService } from '../../../../services/dialogs/common/dialogs.js';
import { GroupDirection, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkService } from '../../../../services/work/common/work.js';
import '../../../../workbench.web.main.js';
import {
  CharacterTemplateEditorSerializer, ICharacterTemplateInputService,
} from '../../browser/characterTemplateEditorInput.js';

const workId = '00000000-0000-4000-8000-000000000001';
const otherWorkId = '00000000-0000-4000-8000-000000000002';
const disposables = new DisposableStore();

afterEach(() => disposables.clear());

function fields(label: string): CharacterTemplate {
  return [{ id: 'goal', label, kind: 'text' }];
}

function setup() {
  let snapshot: CharacterTemplateSnapshot = { fields: getDefaultCharacterTemplate(), revision: 0 };
  const changed = disposables.add(new Emitter<string>());
  const getTemplate = vi.fn(async (_workId: string) => structuredClone(snapshot));
  const putTemplate = vi.fn(async (id: string, fields: CharacterTemplate, expected: number) => {
    if (expected !== snapshot.revision) {
      throw new CharacterStoreError('conflict', snapshot.revision);
    }
    snapshot = { fields, revision: expected + 1 };
    changed.fire(id);
    return structuredClone(snapshot);
  });
  const warn = vi.fn();
  const error = vi.fn();
  const confirm = vi.fn(async () => ConfirmResult.DONT_SAVE);
  const services = new ServiceCollection(
    [ICharactersService, { store: { getTemplate, putTemplate }, onDidChangeTemplate: changed.event }],
    [IFileDialogService, { showSaveConfirm: confirm }],
    [INotificationService, { warn, error }],
    [IWorkService, { current: { id: workId } }],
    [IStorageService, disposables.add(new InMemoryStorageService())],
  );
  const instantiation = new InstantiationService(services);
  const inputs = instantiation.invokeFunction(accessor => accessor.get(ICharacterTemplateInputService));
  const input = disposables.add(inputs.getOrCreate(workId));
  return {
    input, inputs, instantiation, services, getTemplate, putTemplate, warn, error, confirm,
    changeTemplate(revision: number, draft: CharacterTemplate, eventWorkId?: string) {
      snapshot = { revision, fields: draft };
      if (eventWorkId) {
        changed.fire(eventWorkId);
      }
    },
  };
}

test('loads the default without writing and uses the PUT response as the clean baseline', async () => {
  const { input, putTemplate, warn } = setup();
  const dirty = vi.fn(() => input.isDirty());
  input.onDidChangeDirty(dirty);

  await input.resolve();
  expect(input.fields).toEqual(getDefaultCharacterTemplate());
  expect(input.isDirty()).toBe(false);
  expect(await input.save()).toBe(input);
  expect(putTemplate).not.toHaveBeenCalled();

  input.setFields(fields('  목표  '));
  expect(input.isDirty()).toBe(true);
  expect(await input.save()).toBe(input);
  expect(putTemplate).toHaveBeenCalledExactlyOnceWith(workId, fields('목표'), 0);
  expect(input.fields).toEqual(fields('목표'));
  expect(input.isDirty()).toBe(false);
  expect(dirty.mock.results.map(result => result.value)).toEqual([true, false]);
  expect(warn).not.toHaveBeenCalled();
});

test('rereads after a stale PUT, preserves the draft and requires an explicit reload before a fresh save', async () => {
  const { input, getTemplate, putTemplate, warn, changeTemplate } = setup();
  await input.resolve();
  input.setFields(fields('My draft'));
  changeTemplate(1, fields('Other window'));

  expect(await input.save()).toBeUndefined();
  expect(putTemplate).toHaveBeenCalledExactlyOnceWith(workId, fields('My draft'), 0);
  expect(getTemplate).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(input.hasConflict).toBe(true);
  expect(input.isDirty()).toBe(true);
  expect(input.fields).toEqual(fields('My draft'));
  expect(await input.save()).toBeUndefined();
  expect(putTemplate).toHaveBeenCalledTimes(1);

  await input.reload();
  expect(input.isDirty()).toBe(false);
  expect(input.hasConflict).toBe(false);
  expect(input.fields).toEqual(fields('Other window'));
  input.setFields(fields('New draft'));
  expect(await input.save()).toBe(input);
  expect(putTemplate).toHaveBeenLastCalledWith(workId, fields('New draft'), 1);
});

test('fails safely when a conflict read fails, then loads the saved version on retry', async () => {
  const { input, getTemplate, putTemplate, changeTemplate } = setup();
  await input.resolve();
  input.setFields(fields('Draft'));
  changeTemplate(2, fields('Saved elsewhere'));
  getTemplate.mockRejectedValueOnce(new Error('Offline'));
  await input.save();
  expect(input.hasConflict).toBe(true);
  expect(input.hasReadError).toBe(true);
  expect(input.fields).toEqual(fields('Draft'));
  expect(await input.save()).toBeUndefined();
  expect(await input.overwrite()).toBeUndefined();
  expect(putTemplate).toHaveBeenCalledTimes(1);

  await input.reload();
  expect(input.hasReadError).toBe(false);
  expect(input.hasConflict).toBe(false);
  expect(input.fields).toEqual(fields('Saved elsewhere'));
});

test('overwrites only on explicit selection and asks again if the reread revision has changed', async () => {
  const { input, putTemplate, warn, changeTemplate } = setup();
  await input.resolve();
  input.setFields(fields('Draft'));
  changeTemplate(1, fields('First external save'));
  expect(await input.save()).toBeUndefined();
  expect(input.canOverwrite).toBe(true);
  changeTemplate(2, fields('Second external save'));

  expect(await input.overwrite()).toBeUndefined();
  expect(putTemplate).toHaveBeenLastCalledWith(workId, fields('Draft'), 1);
  expect(putTemplate).toHaveBeenCalledTimes(2);
  expect(input.fields).toEqual(fields('Draft'));
  expect(warn).toHaveBeenCalledTimes(2);
  expect(await input.save()).toBeUndefined();
  expect(putTemplate).toHaveBeenCalledTimes(2);

  expect(await input.overwrite()).toBe(input);
  expect(putTemplate).toHaveBeenLastCalledWith(workId, fields('Draft'), 2);
  expect(input.isDirty()).toBe(false);
  expect(input.hasConflict).toBe(false);
});

test('refreshes a clean input on same-window changes and flags a dirty input without replacing its draft', async () => {
  const { input, getTemplate, warn, changeTemplate } = setup();
  await input.resolve();
  changeTemplate(1, fields('Unrelated event'), otherWorkId);
  expect(getTemplate).toHaveBeenCalledTimes(1);
  changeTemplate(1, fields('First save'), workId);
  await vi.waitFor(() => expect(input.fields).toEqual(fields('First save')));
  expect(input.isDirty()).toBe(false);

  input.setFields(fields('Local draft'));
  changeTemplate(2, fields('Second save'), workId);
  await vi.waitFor(() => expect(input.hasConflict).toBe(true));
  expect(input.fields).toEqual(fields('Local draft'));
  expect(warn).toHaveBeenCalledTimes(1);
});

test('shares a pending save and keeps edits made while it was in flight', async () => {
  const { input, putTemplate } = setup();
  const resume = new DeferredPromise<void>();
  const put = putTemplate.getMockImplementation()!;
  putTemplate.mockImplementationOnce(async (...args) => {
    await resume.p;
    return put(...args);
  });
  await input.resolve();
  input.setFields(fields('First'));
  const saving = input.save();
  await vi.waitFor(() => expect(putTemplate).toHaveBeenCalledTimes(1));
  expect(input.save()).toBe(saving);
  input.setFields(fields('Second'));
  await resume.complete();
  expect(await saving).toBeUndefined();
  expect(input.isDirty()).toBe(true);
  expect(input.fields).toEqual(fields('Second'));
  expect(await input.save()).toBe(input);
  expect(putTemplate).toHaveBeenLastCalledWith(workId, fields('Second'), 1);
});

test('uses shared validation and leaves invalid edits open', async () => {
  const { input, error, putTemplate } = setup();
  await input.resolve();
  input.setFields(fields(' '));
  expect(await input.save()).toBeUndefined();
  expect(input.isDirty()).toBe(true);
  expect(putTemplate).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledTimes(1);
});

test('serializes only the work ID, reuses the live input, and rejects another work', async () => {
  const { input, inputs, instantiation, getTemplate } = setup();
  const serializer = new CharacterTemplateEditorSerializer();
  await input.resolve();
  input.setFields(fields('Unsaved'));
  expect(input.resource.toString()).toBe('character-template://' + workId);
  expect(serializer.serialize(input)).toBe(workId);
  expect(serializer.deserialize(instantiation, otherWorkId)).toBeUndefined();
  expect(serializer.deserialize(instantiation, workId)).toBe(input);
  input.dispose();

  const restored = disposables.add(serializer.deserialize(instantiation, workId)!);
  expect(restored).not.toBe(input);
  expect(restored).toBe(inputs.getOrCreate(workId));
  expect(getTemplate).toHaveBeenCalledTimes(1);
  await restored.resolve();
  expect(restored.fields).toEqual(getDefaultCharacterTemplate());
  expect(restored.isDirty()).toBe(false);
});

test('confirms only the last close of two tabs with the same draft, then discards without writing', async () => {
  const { input, instantiation, services, confirm, putTemplate } = setup();
  const part = disposables.add(instantiation.createInstance(EditorPart));
  services.set(IEditorGroupsService, part);
  const parent = document.body.appendChild(document.createElement('div'));
  disposables.add({ dispose: () => parent.remove() });
  part.create(parent);
  part.layout(1000, 600, 0, 0);
  const left = part.activeGroup;
  const right = part.addGroup(left, GroupDirection.RIGHT);
  await left.openEditor(input);
  await right.openEditor(input);
  input.setFields(fields('Unsaved'));

  expect(await left.closeEditor(input)).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  expect(input.isDisposed()).toBe(false);
  expect(input.isDirty()).toBe(true);
  confirm.mockResolvedValueOnce(ConfirmResult.CANCEL);
  expect(await right.closeEditor(input)).toBe(false);
  expect(right.contains(input)).toBe(true);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(['Field Template']);
  confirm.mockClear();
  expect(await right.closeEditor(input)).toBe(true);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(['Field Template']);
  expect(input.isDisposed()).toBe(true);
  expect(putTemplate).not.toHaveBeenCalled();
});
