import { afterEach, expect, test, vi } from 'vitest';
import { DeferredPromise } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import { FieldCardModel, type FieldCardAdapter, type FieldCardHold, type FieldCardSnapshot } from '../fieldCardModel.js';

type Draft = { readonly name: string };
const initial = { name: 'Initial' };
const disposables = new DisposableStore();
afterEach(() => {
  disposables.clear();
  vi.useRealTimers();
});

function setup(hooks: Pick<FieldCardAdapter<Draft>, 'validate' | 'review'> = {}) {
  let snapshot: FieldCardSnapshot<Draft> = { value: initial, revision: 1 };
  const write = vi.fn(async (value: Draft, revision: number) => {
    if (!snapshot.value) {
      throw new Error('deleted');
    }
    if (snapshot.revision !== revision) {
      throw new Error('conflict');
    }
    const result = { value, revision: revision + 1 };
    snapshot = result;
    return result;
  });
  const prompt = vi.fn<IDialogService['prompt']>(() => ({ result: Promise.resolve(undefined), close() {} }));
  const error = vi.fn();
  const model = disposables.add(new FieldCardModel(initial, 1, {
    read: async () => snapshot,
    write,
    conflictRevision: error => error instanceof Error && error.message === 'conflict'
      ? { revision: snapshot.revision }
      : undefined,
    isNotFound: error => error instanceof Error && error.message === 'deleted',
    sameSaved: (a, b) => a.name === b.name,
    sameContent: (a, b) => a.name.trim() === b.name.trim(),
    normalize: value => ({ name: value.name.trim() }),
    label: value => value.name,
    ...hooks,
  }, { _serviceBrand: undefined, prompt }, { error, warn: vi.fn() } as unknown as INotificationService));
  return { model, write, prompt, error, external(value?: Draft) {
    snapshot = { value, revision: snapshot.revision + 1 };
  } };
}

test('waits for every composing input before idle save and keeps raw text after the response', async () => {
  vi.useFakeTimers();
  const { model, write } = setup();
  const first = model.beginComposition();
  const second = model.beginComposition();
  model.edit({ name: '한 ' });
  first.dispose();
  await vi.advanceTimersByTimeAsync(2000);
  expect(write).not.toHaveBeenCalled();
  second.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(write).toHaveBeenCalledExactlyOnceWith({ name: '한' }, 1);
  expect(model.draft.name).toBe('한 ');
  expect(model.dirty).toBe(false);
});

test('saves current preedit explicitly while deferring conflict prompts until composition ends', async () => {
  vi.useFakeTimers();
  const { model, write, external, prompt } = setup();
  external({ name: 'Remote' });
  const composing = model.beginComposition();
  model.edit({ name: '한 ' });
  const result = model.save('explicit');
  await vi.advanceTimersByTimeAsync(0);
  expect(write).toHaveBeenCalledExactlyOnceWith({ name: '한' }, 1);
  expect(model.draft.name).toBe('한 ');
  expect(prompt).not.toHaveBeenCalled();
  composing.dispose();
  await expect(result).resolves.toBe(false);
  expect(prompt).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(write).toHaveBeenCalledOnce();
  model.edit({ name: '한글' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(prompt).toHaveBeenCalledTimes(2);
});

test('retries an unrelated revision without prompting, and handles deletion and disposal', async () => {
  vi.useFakeTimers();
  const { model, write, external, prompt, error } = setup();
  external(initial);
  model.edit({ name: 'Draft' });
  await expect(model.save('explicit')).resolves.toBe(true);
  expect(write.mock.calls.map(([, revision]) => revision)).toEqual([1, 2]);
  expect(prompt).not.toHaveBeenCalled();
  external();
  model.edit({ name: 'Copy this' });
  await expect(model.save('explicit')).resolves.toBe(false);
  expect(model.deleted).toBe(true);
  expect(model.dirty).toBe(false);
  expect(model.draft.name).toBe('Copy this');
  expect(error).not.toHaveBeenCalled();

  const next = setup();
  next.model.edit({ name: 'Pending' });
  next.model.dispose();
  await vi.advanceTimersByTimeAsync(2000);
  expect(next.write).not.toHaveBeenCalled();
});

const blankProblem = { fieldId: 'name', message: 'Enter a name.' };
const validate = (draft: Draft) => draft.name.trim() ? [] : [blankProblem];

test('blocks invalid drafts, requests field focus on explicit save and saves after correction', async () => {
  vi.useFakeTimers();
  const { model, write, prompt } = setup({ validate });
  const focus = vi.fn();
  disposables.add(model.onDidRequestSaveBlockFocus(focus));
  model.edit({ name: '  ' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(model.saveBlock).toEqual({ kind: 'validation', problems: [blankProblem] });
  expect(model.draft.name).toBe('  ');
  expect(model.dirty).toBe(true);
  expect(focus).not.toHaveBeenCalled();
  await expect(model.save('explicit')).resolves.toBe(false);
  expect(focus).toHaveBeenCalledExactlyOnceWith(model.saveBlock);
  await expect(model.confirmClose()).resolves.toBe(false);
  expect(prompt.mock.lastCall?.[0].buttons).toEqual(['Keep Editing', 'Discard']);
  expect(write).not.toHaveBeenCalled();
  model.edit({ name: 'Corrected' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(write).toHaveBeenCalledExactlyOnceWith({ name: 'Corrected' }, 1);
});

const hold = { message: 'Existing dates will need review.' };

test('keeps a confirmation until Apply, Discard, or a fresh edit', async () => {
  vi.useFakeTimers();
  const review = vi.fn(async () => hold);
  const { model, write, prompt } = setup({ review });
  const focus = vi.fn();
  disposables.add(model.onDidRequestSaveBlockFocus(focus));
  model.edit({ name: 'Review first' });
  await vi.advanceTimersByTimeAsync(1000);
  await expect(model.save('explicit')).resolves.toBe(false);
  expect(focus).toHaveBeenCalledExactlyOnceWith({ kind: 'confirmation', hold });
  expect(write).not.toHaveBeenCalled();
  await model.discardDraft();
  expect(model.draft).toEqual(initial);
  expect(model.saveBlock).toBeUndefined();
  model.edit({ name: 'Next' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(review).toHaveBeenCalledTimes(2);
  expect(write).not.toHaveBeenCalled();
  prompt.mockReturnValueOnce({ result: Promise.resolve(0), close() {} });
  await expect(model.confirmClose()).resolves.toBe(true);
  expect(prompt.mock.lastCall?.[0].buttons).toEqual(['Apply and Close', 'Discard', 'Cancel']);
  expect(write).toHaveBeenCalledExactlyOnceWith({ name: 'Next' }, 1);
  expect(model.dirty).toBe(false);
});

test('drops a late review result for a replaced draft and checks the replacement at idle', async () => {
  vi.useFakeTimers();
  const review = vi.fn<NonNullable<FieldCardAdapter<Draft>['review']>>(async () => hold);
  const pending = new DeferredPromise<FieldCardHold | undefined>();
  review.mockReturnValueOnce(pending.p);
  const { model, write } = setup({ review });
  model.edit({ name: 'First' });
  await vi.advanceTimersByTimeAsync(1000);
  model.edit({ name: 'Second' });
  await pending.complete(undefined);
  await model.waitForSave();
  expect(model.saveBlock).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(review.mock.calls.map(([draft]) => draft.name)).toEqual(['First', 'Second']);
  expect(model.saveBlock).toEqual({ kind: 'confirmation', hold });
  await expect(model.applyChange()).resolves.toBe(true);
  expect(write).toHaveBeenCalledExactlyOnceWith({ name: 'Second' }, 1);
});

test('drops an in-flight review even when an edit returns to the same draft object', async () => {
  const pending = new DeferredPromise<FieldCardHold | undefined>();
  const review = vi.fn<NonNullable<FieldCardAdapter<Draft>['review']>>(() => pending.p);
  const { model, write } = setup({ review });
  const draft = { name: 'Draft' };
  model.edit(draft);
  const save = model.save('explicit');
  await Promise.resolve();
  expect(review).toHaveBeenCalledOnce();
  model.edit({ name: 'Intermediate' });
  model.edit(draft);
  await pending.complete(undefined);
  await expect(save).resolves.toBe(false);
  expect(write).not.toHaveBeenCalled();
  expect(model.dirty).toBe(true);
});

test('review failure keeps the draft and offers a retry or explicit Apply', async () => {
  const review = vi.fn<NonNullable<FieldCardAdapter<Draft>['review']>>(async () => {
    throw new Error('offline');
  });
  const { model, write } = setup({ review });
  model.edit({ name: 'Draft' });
  await expect(model.save('explicit')).resolves.toBe(false);
  expect(model.saveBlock).toEqual({ kind: 'reviewError', message: 'Could not check what this change affects.' });
  expect(model.dirty).toBe(true);
  expect(write).not.toHaveBeenCalled();
  review.mockResolvedValueOnce(hold);
  await expect(model.retryReview()).resolves.toBe(false);
  expect(model.saveBlock).toEqual({ kind: 'confirmation', hold });
  expect(write).not.toHaveBeenCalled();
  await expect(model.applyChange()).resolves.toBe(true);
  expect(write).toHaveBeenCalledOnce();
});

test('an Apply confirmation does not carry over to a changed store revision', async () => {
  const review = vi.fn(async () => hold);
  const { model, write, external } = setup({ review });
  model.edit({ name: 'Draft' });
  await expect(model.save('explicit')).resolves.toBe(false);
  external(initial);
  await expect(model.applyChange()).resolves.toBe(false);
  expect(review).toHaveBeenCalledTimes(2);
  expect(write.mock.calls.map(([, revision]) => revision)).toEqual([1]);
  await expect(model.applyChange()).resolves.toBe(true);
  expect(write.mock.calls.map(([, revision]) => revision)).toEqual([1, 2]);
});

test('an explicit save that waits on a review dropped for a newer edit checks and saves that edit', async () => {
  const pending = new DeferredPromise<FieldCardHold | undefined>();
  const review = vi.fn<NonNullable<FieldCardAdapter<Draft>['review']>>(async () => undefined);
  review.mockReturnValueOnce(pending.p);
  const { model, write } = setup({ review });
  model.edit({ name: 'First' });
  const auto = model.save('auto');
  await Promise.resolve();
  model.edit({ name: 'Second' });
  const explicit = model.save('explicit');
  await pending.complete(undefined);
  await expect(auto).resolves.toBe(false);
  await expect(explicit).resolves.toBe(true);
  expect(review.mock.calls.map(([draft]) => draft.name)).toEqual(['First', 'Second']);
  expect(write).toHaveBeenCalledExactlyOnceWith({ name: 'Second' }, 1);
});

test('holds wait for every composition to end before requesting focus', async () => {
  const review = vi.fn(async () => hold);
  const { model, write } = setup({ validate, review });
  const focus = vi.fn();
  disposables.add(model.onDidRequestSaveBlockFocus(focus));
  const first = model.beginComposition();
  const second = model.beginComposition();
  model.edit({ name: ' ' });
  await expect(model.save('explicit')).resolves.toBe(false);
  expect(model.saveBlock?.kind).toBe('validation');
  first.dispose();
  expect(focus).not.toHaveBeenCalled();
  second.dispose();
  expect(focus).toHaveBeenCalledExactlyOnceWith(model.saveBlock);

  const composing = model.beginComposition();
  model.edit({ name: '한' });
  await expect(model.save('explicit')).resolves.toBe(false);
  expect(model.saveBlock).toEqual({ kind: 'confirmation', hold });
  model.edit({ name: '한글' });
  composing.dispose();
  expect(focus).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
});

test('a review still pending at deletion or disposal never writes', async () => {
  for (const end of ['delete', 'dispose'] as const) {
    const pending = new DeferredPromise<FieldCardHold | undefined>();
    const { model, write } = setup({ review: () => pending.p });
    model.edit({ name: 'Draft' });
    const save = model.save('explicit');
    await Promise.resolve();
    if (end === 'delete') {
      model.markDeleted();
    } else {
      model.dispose();
    }
    await pending.complete(undefined);
    await expect(save).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  }
});

test('does not autosave while the close prompt is open, so Discard still discards', async () => {
  vi.useFakeTimers();
  const { model, write, prompt } = setup();
  const choice = new DeferredPromise<number | undefined>();
  prompt.mockReturnValueOnce({ result: choice.p, close() {} });
  model.edit({ name: 'Draft' });
  const closing = model.confirmClose();
  await vi.advanceTimersByTimeAsync(0);
  expect(prompt).toHaveBeenCalledOnce();
  model.scheduleAutoSave(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(write).not.toHaveBeenCalled();
  await choice.complete(1);
  await expect(closing).resolves.toBe(true);
  expect(model.draft).toEqual(initial);
  expect(write).not.toHaveBeenCalled();
});
