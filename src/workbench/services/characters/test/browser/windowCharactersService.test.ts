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

it('emits template changes locally and keeps the character tree event independent', async () => {
  const manuscript = new WindowManuscriptService('', 'memory', status => new HttpManuscriptStore(status));
  const service = new WindowCharactersService(manuscript);
  try {
    const { id } = await manuscript.store.createWork({ title: 'Work' });
    const templateChanged = vi.fn();
    const treeChanged = vi.fn();
    service.onDidChangeTemplate(templateChanged);
    service.onDidChangeTree(treeChanged);

    expect(await service.store.getTemplate(id)).toMatchObject({ revision: 0 });
    expect(templateChanged).not.toHaveBeenCalled();
    expect(await service.store.putTemplate(id, [{ id: 'role', label: '  Role  ', kind: 'text' }], 0))
      .toEqual({ revision: 1, fields: [{ id: 'role', label: 'Role', kind: 'text' }] });
    await expect(service.store.putTemplate(id, [], 0)).rejects.toMatchObject({ code: 'conflict', currentRevision: 1 });
    expect(templateChanged.mock.calls).toEqual([[id]]);
    expect(treeChanged).not.toHaveBeenCalled();
    await service.store.createNode(id, { kind: 'character', parentId: null, title: '' }, 0);
    expect(treeChanged.mock.calls).toEqual([[id]]);
    expect(templateChanged.mock.calls).toEqual([[id]]);
  } finally {
    service.dispose();
    manuscript.dispose();
  }
});

it('announces a new revision at the next check and retries after an unavailable read', async () => {
  const manuscript = new WindowManuscriptService('', undefined, status => new HttpManuscriptStore(status));
  const workId = crypto.randomUUID();
  let revision = 0;
  const fetcher = vi.fn(async () => Response.json({ fields: [], revision }));
  const service = new WindowCharactersService(manuscript, status => new HttpCharactersStore(status, fetcher));
  try {
    const changed = vi.fn((id: string) => service.store.getTemplate(id));
    service.onDidChangeTemplate(changed);
    await service.store.getTemplate(workId);
    await service.store.checkTemplateChanges(workId);
    expect(changed).not.toHaveBeenCalled();

    revision = 1;
    await service.store.getTemplate(workId);
    expect(changed).not.toHaveBeenCalled();
    fetcher.mockRejectedValueOnce(new Error('Unavailable'));
    await service.store.checkTemplateChanges(workId);
    expect(changed).not.toHaveBeenCalled();
    await service.store.checkTemplateChanges(workId);
    expect(await changed.mock.results[0].value).toMatchObject({ revision: 1 });
    expect(fetcher).toHaveBeenCalledTimes(5);
    await service.store.checkTemplateChanges(workId);
    expect(changed).toHaveBeenCalledExactlyOnceWith(workId);
  } finally {
    service.dispose();
    manuscript.dispose();
  }
});

it('does not show an older template when overlapping reads complete out of order', async () => {
  const manuscript = new WindowManuscriptService('', undefined, status => new HttpManuscriptStore(status));
  const workId = crypto.randomUUID();
  let finishPrevious!: (response: Response) => void;
  const previous = new Promise<Response>(resolve => { finishPrevious = resolve; });
  const fetcher = vi.fn(async () => Response.json({ fields: [], revision: 1 })).mockReturnValueOnce(previous);
  const service = new WindowCharactersService(manuscript, status => new HttpCharactersStore(status, fetcher));
  try {
    const earlierRead = service.store.getTemplate(workId);
    await expect(service.store.getTemplate(workId)).resolves.toMatchObject({ revision: 1 });
    finishPrevious(Response.json({ fields: [], revision: 0 }));
    await expect(earlierRead).resolves.toMatchObject({ revision: 1 });
    const changed = vi.fn();
    service.onDidChangeTemplate(changed);
    await service.store.checkTemplateChanges(workId);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    service.dispose();
    manuscript.dispose();
  }
});
