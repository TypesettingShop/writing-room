import { expect, test, vi } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import type { CharacterEntry } from '../../../../../platform/characters/common/characters.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ICharactersService } from '../../../../services/characters/common/charactersService.js';
import { IFileDialogService } from '../../../../services/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { characterUri } from '../../browser/characterEditorInput.js';
import { CharacterEditorInputSerializer } from '../../browser/characterEditorSerializer.js';
import { CharacterOpener, ICharacterOpener } from '../../browser/characterOpener.js';
import { ICharactersViewState, type CharactersViewState } from '../../browser/charactersViewState.js';

const workId = '00000000-0000-0000-0000-000000000001';
const nodeId = '00000000-0000-0000-0000-000000000002';
const node: CharacterEntry = {
  id: nodeId, kind: 'character', parentId: null, position: 0, title: 'Rin',
  type: 'unknown', values: {}, createdAt: 0, updatedAt: 0,
};

function setup(cached: CharacterEntry[] | undefined) {
  const onDidChangeTree = new Emitter<void>();
  const ensureLoaded = vi.fn(async () => {});
  const refresh = vi.fn(async () => {});
  const state = {
    workId, ensureLoaded, refresh, onDidChangeTree: onDidChangeTree.event, error: '',
    index: cached && { nodes: new Map(cached.map(node => [node.id, node])) },
    revision: cached && 1,
  };
  const services = new ServiceCollection(
    [ICharactersViewState, state], [ICharactersService, { store: {} }], [IDialogService, {}],
    [IFileDialogService, {}], [INotificationService, {}],
  );
  const instantiation = new InstantiationService(services);
  const groups = { groups: [] };
  const opener = new CharacterOpener(state as unknown as CharactersViewState, groups as unknown as IEditorGroupsService,
    {} as INotificationService, instantiation);
  services.set(ICharacterOpener, opener);
  return {
    state, opener, instantiation, groups,
    read(nodes: CharacterEntry[]) {
      state.error = '';
      state.index = { nodes: new Map(nodes.map(node => [node.id, node])) };
      state.revision = 2;
      onDidChangeTree.fire();
    },
  };
}

test('resolves one input even for concurrent opens and rejects foreign or malformed resources', async () => {
  const { opener, state } = setup([node]);
  const uri = characterUri(workId, nodeId);
  await expect(opener.resolveInput(characterUri(nodeId, nodeId))).resolves.toBeUndefined();
  await expect(opener.resolveInput(uri.with({ path: uri.path + '/' }))).resolves.toBeUndefined();
  await expect(opener.resolveInput(URI.parse(uri.toString() + '?extra'))).resolves.toBeUndefined();
  expect(state.ensureLoaded).not.toHaveBeenCalled();

  const [input, duplicate] = await Promise.all([opener.resolveInput(uri), opener.resolveInput(uri)]);
  expect(input?.getName()).toBe('Rin');
  expect(duplicate).toBe(input);
  input?.dispose();
  const reopened = await opener.resolveInput(uri);
  expect(reopened).not.toBe(input);
  reopened?.dispose();
});


test('refreshes a loaded tree on a resource miss to open a character created in another window', async () => {
  const { opener, state, read } = setup([]);
  state.refresh.mockImplementationOnce(async () => { read([node]); });

  const input = await opener.resolveInput(characterUri(workId, nodeId));
  expect(input?.getName()).toBe('Rin');
  expect(state.refresh).toHaveBeenCalledOnce();
  input?.dispose();
});

const serializer = new CharacterEditorInputSerializer();
const serialized = JSON.stringify({ workId, characterId: nodeId });

test('validates the serialized payload and current work before trying to load', () => {
  const { instantiation, state } = setup(undefined);
  for (const invalid of [
    '[', 'null', '[]', '{}', JSON.stringify({ workId, characterId: 4 }),
    JSON.stringify({ workId, characterId: '../invalid' }),
    JSON.stringify({ workId: nodeId, characterId: nodeId }),
  ]) {
    expect(serializer.deserialize(instantiation, invalid)).toBeUndefined();
  }
  expect(state.ensureLoaded).not.toHaveBeenCalled();
  expect(state.refresh).not.toHaveBeenCalled();
});

test('synchronously restores one loading input for every group and stores only its ids', async () => {
  const { instantiation, state, read } = setup(undefined);
  state.ensureLoaded.mockImplementationOnce(async () => {
    await Promise.resolve();
    read([{ ...node, type: 'animal' }]);
  });
  const first = serializer.deserialize(instantiation, serialized)!;
  const second = serializer.deserialize(instantiation, serialized)!;
  expect(second).toBe(first);
  expect(first.getName()).toBe('Loading character…');
  const model = await first.resolve();
  expect(model).toBe(first.model);
  expect(model).toBeDefined();
  expect(first.getName()).toBe('Rin');
  expect(first.model).toBe(second.model);
  expect(first.getTabIcon()?.id).toBe('character-animal');
  first.model?.edit({ ...first.model.draft, title: 'Unsaved' });
  expect(JSON.parse(serializer.serialize(first)!)).toEqual({ workId, characterId: nodeId });
  first.dispose();
});

test.each(['Sign-in is required.', 'The server is unavailable.'])(
  'keeps an unresolved tab when the tree read fails with %s and retries in place',
  async message => {
    const { instantiation, state, read } = setup(undefined);
    state.ensureLoaded.mockImplementationOnce(async () => { state.error = message; });
    const input = serializer.deserialize(instantiation, serialized)!;
    expect(input.getName()).toBe('Loading character…');
    await expect(input.resolve()).resolves.toBeNull();
    expect(input.isDisposed()).toBe(false);
    expect(input.availability).toBe('unavailable');
    expect(serializer.serialize(input)).toBe(serialized);

    state.refresh.mockImplementationOnce(async () => { read([node]); });
    await input.resolve();
    expect(input.getName()).toBe('Rin');
    expect(input.availability).toBe('ready');
    input.dispose();
  },
);

test('disposes a loading card after a successful tree read confirms it is missing', async () => {
  const { instantiation, state, read } = setup(undefined);
  state.ensureLoaded.mockImplementationOnce(async () => { await Promise.resolve(); read([]); });
  const input = serializer.deserialize(instantiation, serialized)!;
  expect(input.isDisposed()).toBe(false);
  await expect(input.resolve()).resolves.toBeNull();
  expect(input.isDisposed()).toBe(true);
  expect(serializer.serialize(input)).toBeUndefined();
});

test('refreshes once per open of a resource still missing after the refresh, and never for an unloaded tree', async () => {
  const { opener, state } = setup([]);
  await expect(opener.resolveInput(characterUri(workId, nodeId))).resolves.toBeUndefined();
  expect(state.refresh).toHaveBeenCalledOnce();

  const unloaded = setup(undefined);
  await expect(unloaded.opener.resolveInput(characterUri(workId, nodeId))).resolves.toBeUndefined();
  expect(unloaded.state.ensureLoaded).toHaveBeenCalledOnce();
  expect(unloaded.state.refresh).not.toHaveBeenCalled();
});

test('does not take a stale tree without the character as a deletion while the last read failed', async () => {
  const { instantiation, state } = setup([]);
  state.error = 'The server is unavailable.';
  const input = serializer.deserialize(instantiation, serialized)!;
  await expect(input.resolve()).resolves.toBeNull();
  expect(input.availability).toBe('unavailable');
  expect(input.isDisposed()).toBe(false);
  expect(serializer.serialize(input)).toBe(serialized);
  input.dispose();
});
