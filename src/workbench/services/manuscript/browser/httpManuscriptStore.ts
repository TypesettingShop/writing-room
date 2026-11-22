import {
  documentEtag, documentSize, isManuscriptId, isManuscriptRevision, isManuscriptStoreErrorCode, isRecord, manuscriptLimits,
  ManuscriptStoreError, type DocumentStat, type ManuscriptDocument, type ManuscriptTree, type ManuscriptWork,
} from '../../../../platform/manuscript/common/manuscript.js';
import type {
  CreateNode, ManuscriptStore, NodeChange, NodeDeletion, NodeDestination, TreeChange, UpdateNode,
} from '../../../../platform/manuscript/common/manuscriptStore.js';
import { ManuscriptStatus } from './windowManuscriptService.js';

export type ManuscriptFetch = (path: string, init?: RequestInit) => Promise<Response>;

export class ManuscriptUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('The manuscript server is unavailable.', { cause });
  }
}

const worksPath = '/api/works';
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function idSegment(id: string): string {
  if (!isManuscriptId(id)) {
    throw new ManuscriptStoreError('not_found');
  }
  return '/' + id;
}

function documentPath(workId: string, nodeId: string): string {
  return worksPath + idSegment(workId) + '/documents' + idSegment(nodeId);
}

function readStat(mtime: unknown, size: unknown): DocumentStat {
  if (!isManuscriptRevision(mtime) || !isManuscriptRevision(size) || size > manuscriptLimits.document) {
    throw new Error('Invalid document stat.');
  }
  return { mtime, size };
}

function readStatHeaders(headers: Headers): DocumentStat {
  const mtime = headers.get('X-Manuscript-Mtime');
  const size = headers.get('X-Manuscript-Size');
  if (!mtime || !size || !/^\d+$/.test(mtime) || !/^\d+$/.test(size)) {
    throw new Error('Missing document stat headers.');
  }
  const stat = readStat(Number(mtime), Number(size));
  if (headers.get('ETag') !== '"' + documentEtag(stat.mtime, stat.size) + '"') {
    throw new Error('Invalid document etag.');
  }
  return stat;
}

export class HttpManuscriptStore implements ManuscriptStore {
  private readonly fetcher: ManuscriptFetch;
  private readonly status: ManuscriptStatus;

  constructor(status: ManuscriptStatus, fetcher: ManuscriptFetch = (path, init) => globalThis.fetch(path, init)) {
    this.status = status;
    this.fetcher = fetcher;
  }

  get onDidChangeAuth() {
    return this.status.onDidChangeAuth;
  }

  async listWorks(): Promise<ManuscriptWork[]> {
    return (await this.json<{ works: ManuscriptWork[] }>(worksPath)).works;
  }

  async createWork(input: { title: string }): Promise<ManuscriptWork> {
    return (await this.json<{ work: ManuscriptWork }>(worksPath, 'POST', input)).work;
  }

  async getWork(workId: string): Promise<ManuscriptWork> {
    return (await this.json<{ work: ManuscriptWork }>(worksPath + idSegment(workId))).work;
  }

  async getTree(workId: string): Promise<ManuscriptTree> {
    return this.json(worksPath + idSegment(workId) + '/tree');
  }

  async createNode(workId: string, input: CreateNode, expectedRevision: number): Promise<NodeChange> {
    return this.json(worksPath + idSegment(workId) + '/nodes', 'POST', { ...input, expectedRevision });
  }

  async updateNode(workId: string, nodeId: string, input: UpdateNode, expectedRevision: number): Promise<NodeChange> {
    return this.json(worksPath + idSegment(workId) + '/nodes' + idSegment(nodeId), 'PATCH', { ...input, expectedRevision });
  }

  async moveNodes(workId: string, nodeIds: readonly string[], destination: NodeDestination, expectedRevision: number): Promise<TreeChange> {
    return this.json(worksPath + idSegment(workId) + '/nodes/move', 'POST', { ...destination, nodeIds, expectedRevision });
  }

  async deleteNode(workId: string, nodeId: string, expectedRevision: number): Promise<NodeDeletion> {
    const path = worksPath + idSegment(workId) + '/nodes' + idSegment(nodeId);
    return this.json(path + '?' + new URLSearchParams({ expectedRevision: String(expectedRevision) }), 'DELETE');
  }

  async statDocument(workId: string, nodeId: string): Promise<DocumentStat> {
    return this.request(documentPath(workId, nodeId), { method: 'HEAD' }, response => readStatHeaders(response.headers));
  }

  async readDocument(workId: string, nodeId: string): Promise<ManuscriptDocument> {
    return this.request(documentPath(workId, nodeId), { method: 'GET' }, async response => {
      const stat = readStatHeaders(response.headers);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== stat.size) {
        throw new Error('Document size does not match its response headers.');
      }
      return { ...stat, content: decoder.decode(bytes) };
    });
  }

  async writeDocument(workId: string, nodeId: string, content: string, expectedEtag?: string): Promise<DocumentStat> {
    const path = documentPath(workId, nodeId);
    documentSize(content);
    const headers = new Headers({ 'Content-Type': 'text/markdown; charset=utf-8' });
    if (expectedEtag !== undefined) {
      headers.set('If-Match', '"' + expectedEtag + '"');
    }
    return this.request(path, { method: 'PUT', headers, body: content }, async response => {
      const result: unknown = await response.json();
      if (!isRecord(result)) {
        throw new Error('Invalid document stat.');
      }
      return readStat(result.mtime, result.size);
    });
  }

  private async json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const init = body === undefined ? { method } : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    };
    return this.request(path, init, async response => await response.json() as T);
  }

  private async request<T>(path: string, init: RequestInit, decode: (response: Response) => T | Promise<T>): Promise<T> {
    const revision = this.status.revision;
    let response: Response;
    try {
      response = await this.fetcher(path, { ...init, credentials: 'same-origin' });
    } catch (error) {
      this.status.report('unavailable', revision);
      throw new ManuscriptUnavailableError(error);
    }
    if (response.ok) {
      try {
        const result = await decode(response);
        this.status.report('ready', revision);
        return result;
      } catch (error) {
        this.status.report('unavailable', revision);
        throw new ManuscriptUnavailableError(error);
      }
    }
    if (response.status === 401) {
      this.status.report('signedOut', revision);
      throw new ManuscriptStoreError('unauthorized');
    }
    if (init.method === 'HEAD' && response.status === 404) {
      this.status.report('ready', revision);
      throw new ManuscriptStoreError('not_found');
    }
    if (init.method === 'HEAD' && response.status === 403) {
      this.status.report('unavailable', revision);
      throw new Error('The manuscript server does not allow this address.');
    }
    let body: unknown;
    if (response.status < 500 && response.headers.get('Content-Type')?.startsWith('application/json')) {
      body = await response.json().catch(() => undefined);
    }
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
      const { code, currentRevision } = body.error;
      if (isManuscriptStoreErrorCode(code) && (currentRevision === undefined || isManuscriptRevision(currentRevision)) &&
        (code !== 'conflict' || currentRevision !== undefined)) {
        this.status.report('ready', revision);
        throw new ManuscriptStoreError(code, currentRevision);
      }
      if (code === 'forbidden_host') {
        this.status.report('unavailable', revision);
        throw new Error(body.error.message);
      }
      if (code === 'forbidden_origin' || code === 'unsupported_media_type' || code === 'method_not_allowed') {
        throw new Error(body.error.message);
      }
    }
    this.status.report('unavailable', revision);
    throw new ManuscriptUnavailableError();
  }
}
