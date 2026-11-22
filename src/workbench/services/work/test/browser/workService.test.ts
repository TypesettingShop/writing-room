import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ConfirmResult, EditorInput } from '../../../../common/editor/editorInput.js';
import type { IEditorCloseHandler } from '../../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../editor/common/editorGroupsService.js';
import { WorkService } from '../../browser/workService.js';

const workId = '12345678-abcd-4000-8000-123456789abc';
let originalUrl: string;
let originalState: unknown;

beforeEach(() => {
  originalUrl = window.location.href;
  originalState = history.state;
});

afterEach(() => history.replaceState(originalState, '', originalUrl));

class DirtyEditor extends EditorInput {
  readonly typeId = 'test.dirty';
  readonly resource = undefined;
  dirty = true;

  constructor(private readonly name: string, override readonly closeHandler?: IEditorCloseHandler) {
    super();
  }

  override getName() { return this.name; }
  override isDirty() { return this.dirty; }

  override save = vi.fn(async (): Promise<EditorInput | undefined> => {
    this.dirty = false;
    return this;
  });

  override revert = vi.fn(async () => { this.dirty = false; });
}

function confirm(editorName: string, answer = ConfirmResult.DONT_SAVE) {
  const ask = vi.fn(async () => answer);
  const editor: DirtyEditor = new DirtyEditor(editorName, { confirm: ask, showConfirm: () => editor.isDirty() });
  return { editor, ask };
}

function setup(...editors: DirtyEditor[]) {
  const group = {
    id: 1,
    get editors() { return editors.filter(editor => !editor.isDisposed()); },
    get isEmpty() { return this.editors.length === 0; },
    closeAllEditors: vi.fn(async () => {
      for (const editor of editors) {
        editor.dispose();
      }
      return true;
    }),
  };
  const error = vi.fn();
  history.replaceState(null, '', '/?work=' + workId);
  const service = new WorkService(new InstantiationService(new ServiceCollection(
    [IEditorGroupsService, { groups: [group], getGroup: () => group }],
    [INotificationService, { error }],
  )));
  // jsdom handles same-document navigation. The service retains the Work from startup.
  history.replaceState(null, '', '/#before-close');
  return { service, group, error };
}

test('reports a dirty editor that cannot participate in save confirmation', async () => {
  const editor = new DirtyEditor('settings.json');
  const { service, group, error } = setup(editor);
  try {
    await service.close();
    expect(error).toHaveBeenCalledExactlyOnceWith("Save or revert 'settings.json' before you switch Works.");
    expect(group.closeAllEditors).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#before-close');
  } finally {
    editor.dispose();
  }
});

test('skips a tab disposed while an earlier save prompt was open', async () => {
  const first = confirm('first');
  const removed = confirm('removed');
  const { service, group, error } = setup(first.editor, removed.editor);
  first.ask.mockImplementationOnce(async () => {
    removed.editor.dispose();
    return ConfirmResult.DONT_SAVE;
  });
  try {
    await service.close();
    expect(removed.ask).not.toHaveBeenCalled();
    expect(first.editor.revert).toHaveBeenCalledExactlyOnceWith(1, { soft: true });
    expect(group.isEmpty).toBe(true);
    expect(window.location.hash).toBe('#works');
    expect(error).not.toHaveBeenCalled();
  } finally {
    first.editor.dispose();
    removed.editor.dispose();
  }
});

test('creates a Work only after confirmation and any chosen save succeeds', async () => {
  const first = confirm('first', ConfirmResult.SAVE);
  const second = confirm('second', ConfirmResult.CANCEL);
  const { service, group, error } = setup(first.editor, second.editor);
  const create = vi.fn(async () => undefined);
  try {
    await service.createAndOpen(create);
    expect(create).not.toHaveBeenCalled();
    expect(first.editor.save).not.toHaveBeenCalled();

    second.ask.mockResolvedValue(ConfirmResult.DONT_SAVE);
    first.editor.save.mockResolvedValueOnce(undefined);
    await service.createAndOpen(create);
    expect(create).not.toHaveBeenCalled();
    expect(second.editor.revert).not.toHaveBeenCalled();

    create.mockImplementationOnce(async () => {
      expect(first.editor.isDirty()).toBe(false);
      expect(second.editor.isDirty()).toBe(true);
      return undefined;
    });
    await service.createAndOpen(create);
    expect(create).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(second.editor.revert).not.toHaveBeenCalled();
    expect(group.closeAllEditors).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#before-close');
  } finally {
    first.editor.dispose();
    second.editor.dispose();
  }
});
