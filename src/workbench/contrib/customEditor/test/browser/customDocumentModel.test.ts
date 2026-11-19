import { afterEach, describe, expect, test, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { CustomDocumentModel } from '../../browser/customDocumentModel.js';
import type { ICustomDocumentBackend } from '../../browser/customDocumentModel.js';

const models: CustomDocumentModel[] = [];
afterEach(() => models.splice(0).forEach(model => model.dispose()));

function setup(editable = true) {
  const calls: string[] = [];
  let failSave = false;
  const backend: ICustomDocumentBackend = {
    undo: async id => { calls.push('undo ' + id); },
    redo: async id => { calls.push('redo ' + id); },
    save: async () => {
      calls.push('save');
      if (failSave) {
        throw new Error('disk full');
      }
    },
    saveAs: async target => { calls.push('saveAs ' + target.path); },
    revert: async () => { calls.push('revert'); },
  };
  const model = new CustomDocumentModel('test.view', URI.parse('vscode-vfs://writing-room/workspace/a.bin'), editable, backend);
  models.push(model);
  const dirty = vi.fn();
  model.onDidChangeDirty(dirty);
  return { model, calls, dirty, failSaves: () => { failSave = true; } };
}

describe('the document of a custom editor', () => {
  test('undoes and redoes the edits in order, and is clean at the save point', async () => {
    const { model, calls, dirty } = setup();
    model.acceptEdit(1);
    model.acceptEdit(2);
    expect(model.isDirty()).toBe(true);
    await Promise.all([model.undo(), model.undo(), model.undo()]);
    expect(calls).toEqual(['undo 2', 'undo 1']);
    expect(model.isDirty()).toBe(false);
    await model.redo();
    await model.save();
    expect(model.isDirty()).toBe(false);
    model.acceptEdit(3);
    expect(model.isDirty()).toBe(true);
    await model.undo();
    expect(model.isDirty()).toBe(false);
    await model.redo();
    expect(calls).toEqual(['undo 2', 'undo 1', 'redo 1', 'save', 'undo 3', 'redo 3']);
    expect(dirty.mock.calls.length).toBe(7);
  });

  test('a new edit after undo cuts off the redo history, and the save point with it', async () => {
    const { model, calls } = setup();
    model.acceptEdit(1);
    await model.save();
    await model.undo();
    expect(model.isDirty()).toBe(true);
    model.acceptEdit(2);
    await model.redo();
    expect(calls).toEqual(['save', 'undo 1']);
    await model.undo();
    // The saved state (edit 1 applied) cannot come back any more.
    expect(model.isDirty()).toBe(true);
  });

  test('a change without undo makes it dirty until saved; a failed save leaves it dirty; revert forgets the edits', async () => {
    const { model, calls, failSaves } = setup();
    model.acceptContentChange();
    expect(model.isDirty()).toBe(true);
    failSaves();
    await expect(model.save()).rejects.toThrow('disk full');
    expect(model.isDirty()).toBe(true);
    model.acceptEdit(1);
    await model.revert();
    expect(model.isDirty()).toBe(false);
    await model.undo();
    expect(calls).toEqual(['save', 'revert']);
  });

  test('a read-only document is never dirty', () => {
    const { model } = setup(false);
    model.acceptEdit(1);
    model.acceptContentChange();
    expect(model.isDirty()).toBe(false);
  });

  test('the page asks before it goes while a document is dirty', () => {
    const { model } = setup();
    const ask = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(ask()).toBe(false);
    model.acceptEdit(1);
    expect(ask()).toBe(true);
    model.dispose();
    expect(ask()).toBe(false);
  });
});
