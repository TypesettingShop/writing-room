import { expect, test } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import type { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { createEditorTextModelResolver } from '../../browser/editorTextModelResolver.js';

const file = 'vscode-vfs://writing-room/workspace/defs.lft';

/** A workbench resolver that counts the references it hands out, for a model of `resource`'s URI. */
function workbench(options: { canHandle?: boolean } = {}) {
  const state = { held: 0, created: 0 };
  const resolver = {
    canHandleResource: () => options.canHandle ?? true,
    createModelReference: async (resource: URI) => {
      state.created++;
      state.held++;
      return { object: { textEditorModel: { uri: resource } }, dispose: () => { state.held--; } };
    },
  } as unknown as ITextModelService;
  return { resolver, state };
}

test('a resource F12 opens and the workbench resolver handles is resolved there, its reference given back on dispose', async () => {
  const { resolver, state } = workbench();
  const lent = createEditorTextModelResolver({
    resolver, canOpen: () => true, monacoModel: async resource => ({ monaco: resource.toString() }),
  });
  expect(lent.canResolve(file)).toBe(true);
  const reference = await lent.resolve(file);
  expect(reference.model).toEqual({ monaco: file });
  expect(state.held).toBe(1);
  reference.dispose();
  expect(state.held).toBe(0);
});

test('nothing wider than F12: a resource it would not open, or one the resolver cannot handle, stays with Monaco', () => {
  const opened: string[] = [];
  const lent = createEditorTextModelResolver({
    resolver: workbench().resolver,
    canOpen: resource => {
      opened.push(resource.toString());
      return resource.scheme === 'vscode-vfs';
    },
    monacoModel: async () => ({}),
  });
  expect(lent.canResolve('vscode-userdata:/User/globalStorage/other.ext/secret.md')).toBe(false);
  expect(lent.canResolve('inmemory://model/1')).toBe(false);
  expect(lent.canResolve(file)).toBe(true);
  expect(opened).toContain(file);
  expect(createEditorTextModelResolver({ resolver: workbench({ canHandle: false }).resolver, canOpen: () => true, monacoModel: async () => ({}) })
    .canResolve(file)).toBe(false);
});

test('a model the editor package does not have gives the reference back and rejects as Monaco does', async () => {
  const { resolver, state } = workbench();
  const lent = createEditorTextModelResolver({ resolver, canOpen: () => true, monacoModel: async () => null });
  await expect(lent.resolve(file)).rejects.toThrow('Model not found');
  expect(state).toEqual({ held: 0, created: 1 });
});
