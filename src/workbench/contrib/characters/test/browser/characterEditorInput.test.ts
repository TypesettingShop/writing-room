import { expect, test, vi } from 'vitest';
import { Event } from '../../../../../base/common/event.js';
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
import { CharacterOpener } from '../../browser/characterOpener.js';
import { ICharactersViewState, type CharactersViewState } from '../../browser/charactersViewState.js';

const workId = '00000000-0000-0000-0000-000000000001';
const nodeId = '00000000-0000-0000-0000-000000000002';
const node: CharacterEntry = {
  id: nodeId, kind: 'character', parentId: null, position: 0, title: 'Rin',
  type: 'unknown', values: {}, createdAt: 0, updatedAt: 0,
};

test('resolves one input even for concurrent opens and rejects foreign or malformed resources', async () => {
  const ensureLoaded = vi.fn(async () => {});
  const state = {
    workId, ensureLoaded, revision: 1, index: { nodes: new Map([[nodeId, node]]) }, onDidChangeTree: Event.None,
  } as unknown as CharactersViewState;
  const instantiation = new InstantiationService(new ServiceCollection(
    [ICharactersViewState, state], [ICharactersService, { store: {} }], [IDialogService, {}],
    [IFileDialogService, {}], [INotificationService, {}],
  ));
  const opener = new CharacterOpener(state, {} as IEditorGroupsService, {} as INotificationService, instantiation);
  const uri = characterUri(workId, nodeId);
  await expect(opener.resolveInput(characterUri(nodeId, nodeId))).resolves.toBeUndefined();
  await expect(opener.resolveInput(uri.with({ path: uri.path + '/' }))).resolves.toBeUndefined();
  await expect(opener.resolveInput(URI.parse(uri.toString() + '?extra'))).resolves.toBeUndefined();
  expect(ensureLoaded).not.toHaveBeenCalled();

  const [input, duplicate] = await Promise.all([opener.resolveInput(uri), opener.resolveInput(uri)]);
  expect(input?.getName()).toBe('Rin');
  expect(duplicate).toBe(input);
  input?.dispose();
  const reopened = await opener.resolveInput(uri);
  expect(reopened).not.toBe(input);
  reopened?.dispose();
});
