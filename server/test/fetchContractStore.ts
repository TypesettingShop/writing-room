import { isManuscriptStoreErrorCode, ManuscriptStoreError, type DocumentStat, type ManuscriptWork } from '../../src/platform/manuscript/common/manuscript.js';
import type { ManuscriptStore } from '../../src/platform/manuscript/common/manuscriptStore.js';
import { testOrigin } from './apiFixture.js';

export function fetchContractStore(fetcher: (url: string, init?: RequestInit) => Promise<Response>, user: string): ManuscriptStore {
  const request = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Origin', testOrigin);
    headers.set('X-Test-User', user);
    const response = await fetcher('/api/works' + path, { ...init, headers });
    if (!response.ok) {
      if (response.status === 404 && init?.method === 'HEAD') {
        throw new ManuscriptStoreError('not_found');
      }
      const { error } = await response.json() as { error: { code: string; currentRevision?: number } };
      if (!isManuscriptStoreErrorCode(error.code)) {
        throw new Error('Unexpected API error: ' + error.code);
      }
      throw new ManuscriptStoreError(error.code, error.currentRevision);
    }
    return response;
  };
  const json = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(path, body === undefined ? { method } : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await response.json() as T;
  };
  const stat = (response: Response): DocumentStat => ({
    mtime: Number(response.headers.get('X-Manuscript-Mtime')),
    size: Number(response.headers.get('X-Manuscript-Size')),
  });
  return {
    async listWorks() { return (await json<{ works: ManuscriptWork[] }>('')).works; },
    async createWork(input) { return (await json<{ work: ManuscriptWork }>('', 'POST', input)).work; },
    async getWork(workId) { return (await json<{ work: ManuscriptWork }>('/' + workId)).work; },
    getTree(workId) { return json('/' + workId + '/tree'); },
    createNode(workId, input, expectedRevision) { return json('/' + workId + '/nodes', 'POST', { ...input, expectedRevision }); },
    updateNode(workId, nodeId, input, expectedRevision) {
      return json('/' + workId + '/nodes/' + nodeId, 'PATCH', { ...input, expectedRevision });
    },
    moveNodes(workId, nodeIds, destination, expectedRevision) {
      return json('/' + workId + '/nodes/move', 'POST', { nodeIds, ...destination, expectedRevision });
    },
    deleteNode(workId, nodeId, expectedRevision) {
      return json('/' + workId + '/nodes/' + nodeId + '?expectedRevision=' + expectedRevision, 'DELETE');
    },
    async statDocument(workId, nodeId) { return stat(await request('/' + workId + '/documents/' + nodeId, { method: 'HEAD' })); },
    async readDocument(workId, nodeId) {
      const response = await request('/' + workId + '/documents/' + nodeId);
      return { ...stat(response), content: await response.text() };
    },
    async writeDocument(workId, nodeId, content, expectedEtag) {
      const headers = new Headers({ 'Content-Type': 'text/markdown' });
      if (expectedEtag !== undefined) {
        headers.set('If-Match', '"' + expectedEtag + '"');
      }
      const response = await request('/' + workId + '/documents/' + nodeId, { method: 'PUT', headers, body: content });
      return await response.json() as DocumentStat;
    },
  };
}
