// @vitest-environment node

import { expect, it, vi } from 'vitest';
import { CharacterStoreError } from '../../../../../platform/characters/common/characters.js';
import { ManuscriptStoreError } from '../../../../../platform/manuscript/common/manuscript.js';
import { HttpManuscriptStore } from '../../../manuscript/browser/httpManuscriptStore.js';
import { WindowManuscriptService, type ManuscriptStatus } from '../../../manuscript/browser/windowManuscriptService.js';
import { HttpCharactersStore } from '../../browser/httpCharactersStore.js';
import { WindowCharactersService } from '../../browser/windowCharactersService.js';

it('uses the same in-memory works and emits only successful tree changes and character deletions', async () => {
  const manuscript = new WindowManuscriptService('?store=memory', undefined, status => new HttpManuscriptStore(status));
  const createRemote = vi.fn((status: ManuscriptStatus) => new HttpCharactersStore(status));
  const service = new WindowCharactersService(manuscript, createRemote);
  try {
    expect(service.usesMemory).toBe(true);
    expect(createRemote).not.toHaveBeenCalled();
    const changed = vi.fn();
    const deleted = vi.fn();
    service.onDidChangeTree(changed);
    service.onDidDeleteCharacters(deleted);
    const { id } = await manuscript.store.createWork({ title: 'Work' });
    const entry = { kind: 'character', parentId: null, title: '' } as const;
    await expect(service.store.createNode(crypto.randomUUID(), entry, 0)).rejects.toMatchObject({ code: 'not_found' });
    const folder = await service.store.createNode(id, { ...entry, kind: 'folder' }, 0);
    const child = await service.store.createNode(id, { ...entry, parentId: folder.node.id }, 1);

    await service.store.updateNode(id, child.node.id, {}, 2);
    await service.store.moveNodes(id, [child.node.id], { parentId: folder.node.id }, 2);
    await expect(service.store.deleteNode(id, folder.node.id, 0)).rejects.toMatchObject({ code: 'conflict' });
    expect(changed.mock.calls).toEqual([[id], [id]]);
    expect(deleted).not.toHaveBeenCalled();
    expect(await service.store.deleteNode(id, folder.node.id, 2)).toEqual({ revision: 3, deletedCharacterIds: [child.node.id] });
    expect(changed.mock.calls).toEqual([[id], [id], [id]]);
    expect(deleted.mock.calls).toEqual([[{ workId: id, nodeIds: [child.node.id] }]]);
  } finally {
    service.dispose();
    manuscript.dispose();
  }
});

it('shares the manuscript session and ignores a late success from before sign-out', async () => {
  const fetchManuscript = vi.fn(async () => Response.json({ works: [] }));
  const manuscript = new WindowManuscriptService('', undefined, status => new HttpManuscriptStore(status, fetchManuscript));
  let finishPending!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finishPending = resolve; });
  const fetchCharacters = vi.fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ error: { code: 'conflict', message: 'Changed', currentRevision: 2 } }, { status: 409 }));
  const service = new WindowCharactersService(manuscript, status => new HttpCharactersStore(status, fetchCharacters));
  try {
    expect(service.usesMemory).toBe(false);
    const authChanged = vi.fn();
    manuscript.onDidChangeAuth(authChanged);
    await manuscript.store.listWorks();
    expect(manuscript.signedIn).toBe(true);
    const workId = crypto.randomUUID();
    const old = service.store.getTree(workId);
    await expect(service.store.getTree(workId)).rejects.toBeInstanceOf(CharacterStoreError);
    expect(manuscript.signedIn).toBe(false);
    expect(manuscript.availability).toBe('signedOut');
    finishPending(Response.json({ revision: 0, nodes: [] }));
    await old;
    expect(manuscript.signedIn).toBe(false);
    expect(manuscript.availability).toBe('signedOut');
    expect(authChanged.mock.calls).toEqual([[{ signedIn: true, reason: 'request' }], [{ signedIn: false, reason: 'request' }]]);

    const conflict = await service.store.updateNode(workId, crypto.randomUUID(), {}, 1).catch(error => error);
    expect(conflict).toBeInstanceOf(ManuscriptStoreError);
    expect(conflict).toBeInstanceOf(CharacterStoreError);
    expect(conflict).toMatchObject({ code: 'conflict', currentRevision: 2 });
  } finally {
    service.dispose();
    manuscript.dispose();
  }
});
