// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import {
  FileChangeType, FileOperationResult, FileSystemProviderErrorCode, FileType,
} from '../../../../../platform/files/common/files.js';
import { HttpManuscriptStore } from '../../browser/httpManuscriptStore.js';
import { manuscriptDocumentUri, ManuscriptFileSystemProvider, manuscriptScheme } from '../../browser/manuscriptFileSystemProvider.js';
import { WindowManuscriptService } from '../../browser/windowManuscriptService.js';

async function fixture() {
  const service = new WindowManuscriptService('?store=memory', undefined, () => { throw new Error('Unexpected HTTP store'); });
  const { id: workId } = await service.store.createWork({ title: 'Work' });
  const { node } = await service.store.createNode(workId, { parentId: null, kind: 'document', title: '' }, 0);
  const provider = new ManuscriptFileSystemProvider(service, () => workId);
  const files = new FileService();
  files.registerProvider(manuscriptScheme, provider);
  return { service, workId, nodeId: node.id, provider, files, resource: manuscriptDocumentUri(workId, node.id) };
}

describe('manuscript file provider', () => {
  it('checks the work and URI boundary before calling the store', async () => {
    const { files, provider, service, nodeId, workId, resource } = await fixture();
    try {
      const root = resource.with({ path: '/' });
      expect(await provider.stat(root)).toMatchObject({ type: FileType.Directory });
      expect(await provider.readdir(root)).toEqual([]);
      for (const url of [
        manuscriptDocumentUri(crypto.randomUUID(), nodeId),
        resource.with({ path: '/../' + nodeId + '.md' }),
        URI.parse('manuscript://' + workId + '/%2F' + nodeId + '.md'),
        resource.with({ query: 'view=draft' }),
        URI.parse(resource.toString() + '?'),
        resource.with({ fragment: 'start' }),
        resource.with({ path: '/bad-id.md' }),
      ]) {
        await expect(provider.stat(url)).rejects.toMatchObject({
          code: expect.stringMatching(/NoPermissions|EntryNotFound/),
        });
      }

      const welcomeProvider = new ManuscriptFileSystemProvider(service, () => undefined);
      try {
        await expect(welcomeProvider.readFile(resource)).rejects.toMatchObject({ code: FileSystemProviderErrorCode.NoPermissions });
      } finally {
        welcomeProvider.dispose();
      }
    } finally {
      files.dispose();
      provider.dispose();
      service.dispose();
    }
  });

  it('checks the etag, returns byte size and emits only committed local writes and deletes', async () => {
    const { files, provider, service, nodeId, workId, resource } = await fixture();
    const changes = vi.fn();
    const listener = files.onDidFilesChange(event => changes(event.changes));
    try {
      const { etag } = await files.stat(resource);
      const bytes = new TextEncoder().encode('한글');
      await expect(files.writeFile(resource, bytes, { etag })).resolves.toMatchObject({ size: 6 });
      await expect(files.readFile(resource)).resolves.toMatchObject({ size: 6, value: bytes });
      await expect(files.writeFile(resource, new Uint8Array(), { etag })).rejects
        .toMatchObject({ fileOperationResult: FileOperationResult.FILE_MODIFIED_SINCE });
      const missing = manuscriptDocumentUri(workId, crypto.randomUUID());
      await expect(files.writeFile(missing, bytes)).rejects.toMatchObject({ code: FileSystemProviderErrorCode.FileNotFound });
      await expect(files.createFile(missing, bytes)).rejects.toMatchObject({ code: FileSystemProviderErrorCode.FileNotFound });
      await expect(files.createFile(resource, bytes)).rejects.toMatchObject({ code: FileSystemProviderErrorCode.FileExists });
      await expect(provider.delete()).rejects.toMatchObject({ code: FileSystemProviderErrorCode.NoPermissions });
      await service.store.deleteNode(workId, nodeId, 1);
      expect(changes.mock.calls).toEqual([
        [[{ resource, type: FileChangeType.UPDATED }]],
        [[{ resource, type: FileChangeType.DELETED }]],
      ]);
    } finally {
      listener.dispose();
      files.dispose();
      provider.dispose();
      service.dispose();
    }
  });
});

it('reports authentication changes and server outage without switching to memory', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockRejectedValueOnce(new TypeError('Connection refused'))
    .mockResolvedValueOnce(Response.json({ works: [] }));
  const service = new WindowManuscriptService('', undefined, status => new HttpManuscriptStore(status, fetch));
  const auth = vi.fn();
  const availability = vi.fn();
  const authListener = service.onDidChangeAuth(auth);
  const availabilityListener = service.onDidChangeAvailability(availability);
  try {
    await expect(service.store.listWorks()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(service.availability).toBe('signedOut');
    expect(auth).toHaveBeenLastCalledWith({ signedIn: false, reason: 'request' });
    await expect(service.store.listWorks()).rejects.toThrow('The manuscript server is unavailable.');
    expect(service.availability).toBe('unavailable');
    expect(service.signedIn).toBe(false);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(service.usesMemory).toBe(false);
    await expect(service.store.listWorks()).resolves.toEqual([]);
    expect(auth).toHaveBeenLastCalledWith({ signedIn: true, reason: 'request' });
    expect(availability.mock.calls).toEqual([['signedOut'], ['unavailable'], ['ready']]);
    expect(fetch).toHaveBeenLastCalledWith('/api/works', { credentials: 'same-origin', method: 'GET' });
  } finally {
    availabilityListener.dispose();
    authListener.dispose();
    service.dispose();
  }
});

it('keeps an explicit account change when an older Works response arrives late', async () => {
  let settle!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { settle = resolve; });
  const service = new WindowManuscriptService('', undefined, status => new HttpManuscriptStore(status, () => response));
  const auth = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  try {
    const pending = service.store.listWorks();
    await service.auth!.signOut();
    settle(Response.json({ works: [] }));
    await expect(pending).resolves.toEqual([]);
    expect(service.signedIn).toBe(false);
    expect(service.availability).toBe('signedOut');
  } finally {
    auth.mockRestore();
    service.dispose();
  }
});

it('keeps a sign-in from another tab when an earlier unauthorized response arrives late', async () => {
  let settle!: (response: Response) => void;
  const late = new Promise<Response>(resolve => { settle = resolve; });
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockReturnValueOnce(late)
    .mockResolvedValueOnce(Response.json({ works: [] }));
  const service = new WindowManuscriptService('', undefined, status => new HttpManuscriptStore(status, fetch));
  const auth = vi.fn();
  const listener = service.onDidChangeAuth(auth);
  try {
    await expect(service.store.listWorks()).rejects.toMatchObject({ code: 'unauthorized' });
    const stale = service.store.listWorks();
    await expect(service.store.listWorks()).resolves.toEqual([]);
    settle(new Response(null, { status: 401 }));
    await expect(stale).rejects.toMatchObject({ code: 'unauthorized' });
    expect(service.signedIn).toBe(true);
    expect(auth.mock.calls).toEqual([[{ signedIn: false, reason: 'request' }], [{ signedIn: true, reason: 'request' }]]);
  } finally {
    listener.dispose();
    service.dispose();
  }
});

it('explains address rejection for both document stats and JSON requests', async () => {
  const message = 'Host must be a loopback address or an allowed origin.';
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: { code: 'forbidden_host', message } }, { status: 403 }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  const service = new WindowManuscriptService('', undefined, status => new HttpManuscriptStore(status, fetch));
  try {
    await expect(service.store.listWorks()).rejects.toThrow(message);
    expect(service.availability).toBe('unavailable');
    await expect(service.store.statDocument(crypto.randomUUID(), crypto.randomUUID())).rejects
      .toThrow('The manuscript server does not allow this address.');
    expect(service.availability).toBe('unavailable');
  } finally {
    service.dispose();
  }
});
