import {
  documentEtag, isManuscriptId, isManuscriptNodeKind, isManuscriptRevision, ManuscriptStoreError, normalizeManuscriptMetadata,
} from '../../src/platform/manuscript/common/manuscript.js';
import type { NodeDestination } from '../../src/platform/manuscript/common/manuscriptStore.js';
import { readJson, readMarkdown } from '../http/body.js';
import { sendJson } from '../http/errors.js';
import type { Route, RouteContext } from '../http/router.js';

function revision(value: unknown): number {
  if (!isManuscriptRevision(value)) {
    throw new ManuscriptStoreError('invalid');
  }
  return value;
}

function destination({ parentId, beforeId }: Record<string, unknown>): NodeDestination {
  if ((parentId !== null && !isManuscriptId(parentId)) || (beforeId !== undefined && !isManuscriptId(beforeId))) {
    throw new ManuscriptStoreError('invalid');
  }
  return { parentId, beforeId };
}

function title(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ManuscriptStoreError('invalid');
  }
  return value;
}

async function documentResponse({ request, response, store, workId, nodeId }: RouteContext): Promise<void> {
  const document = request.method === 'HEAD' ? undefined : await store.readDocument(workId, nodeId);
  const stat = document ?? await store.statDocument(workId, nodeId);
  response.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Length': stat.size,
    ETag: '"' + documentEtag(stat.mtime, stat.size) + '"',
    'X-Manuscript-Mtime': stat.mtime,
    'X-Manuscript-Size': stat.size,
  }).end(document?.content);
}

export const workRoutes: readonly Route[] = [
  {
    path: '/api/works',
    handlers: {
      GET: async ({ response, store }) => sendJson(response, 200, { works: await store.listWorks() }),
      POST: async ({ request, response, store }) => {
        const body = await readJson(request);
        sendJson(response, 201, { work: await store.createWork({ title: title(body.title) }) });
      },
    },
  },
  {
    path: '/api/works/:workId',
    handlers: {
      GET: async ({ response, store, workId }) => sendJson(response, 200, { work: await store.getWork(workId) }),
    },
  },
  {
    path: '/api/works/:workId/tree',
    handlers: {
      GET: async ({ response, store, workId }) => sendJson(response, 200, await store.getTree(workId)),
    },
  },
  {
    path: '/api/works/:workId/nodes',
    handlers: {
      POST: async ({ request, response, store, workId }) => {
        const body = await readJson(request);
        if (!isManuscriptNodeKind(body.kind)) {
          throw new ManuscriptStoreError('invalid');
        }
        const input = { ...destination(body), kind: body.kind, title: title(body.title) };
        sendJson(response, 201, await store.createNode(workId, input, revision(body.expectedRevision)));
      },
    },
  },
  {
    path: '/api/works/:workId/nodes/move',
    handlers: {
      POST: async ({ request, response, store, workId }) => {
        const body = await readJson(request);
        if (!Array.isArray(body.nodeIds) || !body.nodeIds.every(isManuscriptId)) {
          throw new ManuscriptStoreError('invalid');
        }
        sendJson(response, 200, await store.moveNodes(workId, body.nodeIds, destination(body), revision(body.expectedRevision)));
      },
    },
  },
  {
    path: '/api/works/:workId/nodes/:nodeId',
    handlers: {
      PATCH: async ({ request, response, store, workId, nodeId }) => {
        const body = await readJson(request);
        const input = {
          title: body.title === undefined ? undefined : title(body.title),
          metadata: body.metadata === undefined ? undefined : normalizeManuscriptMetadata(body.metadata),
        };
        sendJson(response, 200, await store.updateNode(workId, nodeId, input, revision(body.expectedRevision)));
      },
      DELETE: async ({ response, query, store, workId, nodeId }) => {
        const [expected, ...duplicates] = query.getAll('expectedRevision');
        if (expected === undefined || !/^\d+$/.test(expected) || duplicates.length) {
          throw new ManuscriptStoreError('invalid');
        }
        sendJson(response, 200, await store.deleteNode(workId, nodeId, revision(Number(expected))));
      },
    },
  },
  {
    path: '/api/works/:workId/documents/:nodeId',
    handlers: {
      GET: documentResponse,
      HEAD: documentResponse,
      PUT: async ({ request, response, store, workId, nodeId }) => {
        const header = request.headers['if-match'];
        const expected = header === undefined ? undefined : /^(?:"([a-v0-9]+)"|([a-v0-9]+))$/.exec(header);
        if (expected === null) {
          throw new ManuscriptStoreError('invalid');
        }
        const content = await readMarkdown(request);
        sendJson(response, 200, await store.writeDocument(workId, nodeId, content, expected?.[1] ?? expected?.[2]));
      },
    },
  },
];
