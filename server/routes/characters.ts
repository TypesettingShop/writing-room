import type { CharacterTemplate } from '../../src/platform/characters/common/characterFields.js';
import { CharacterStoreError } from '../../src/platform/characters/common/characters.js';
import type { CreateCharacterNode, UpdateCharacterNode } from '../../src/platform/characters/common/charactersStore.js';
import type { NodeDestination } from '../../src/platform/manuscript/common/manuscriptStore.js';
import { readJson } from '../http/body.js';
import { sendJson } from '../http/errors.js';
import type { Route } from '../http/router.js';

const prefix = '/api/works/:workId/characters';

export const characterRoutes: readonly Route[] = [
  {
    path: prefix + '/tree',
    handlers: {
      GET: async ({ response, characters, workId }) => sendJson(response, 200, await characters.getTree(workId)),
    },
  },
  {
    path: prefix + '/nodes',
    handlers: {
      POST: async ({ request, response, characters, workId }) => {
        // The shared tree editor validates the contents after checking work ownership and revision.
        const { expectedRevision, ...input } = await readJson(request);
        sendJson(response, 201, await characters.createNode(workId, input as unknown as CreateCharacterNode, expectedRevision as number));
      },
    },
  },
  {
    path: prefix + '/nodes/move',
    handlers: {
      POST: async ({ request, response, characters, workId }) => {
        const { nodeIds, expectedRevision, ...destination } = await readJson(request);
        sendJson(response, 200, await characters.moveNodes(
          workId, nodeIds as string[], destination as unknown as NodeDestination, expectedRevision as number,
        ));
      },
    },
  },
  {
    path: prefix + '/nodes/:nodeId',
    handlers: {
      PATCH: async ({ request, response, characters, workId, nodeId }) => {
        const { expectedRevision, ...input } = await readJson(request);
        sendJson(response, 200, await characters.updateNode(workId, nodeId, input as UpdateCharacterNode, expectedRevision as number));
      },
      DELETE: async ({ response, query, characters, workId, nodeId }) => {
        const [expected, ...duplicates] = query.getAll('expectedRevision');
        if (expected === undefined || !/^\d+$/.test(expected) || duplicates.length) {
          throw new CharacterStoreError('invalid');
        }
        sendJson(response, 200, await characters.deleteNode(workId, nodeId, Number(expected)));
      },
    },
  },
  {
    path: prefix + '/template',
    handlers: {
      GET: async ({ response, characters, workId }) => sendJson(response, 200, await characters.getTemplate(workId)),
      PUT: async ({ request, response, characters, workId }) => {
        const { fields, expectedRevision } = await readJson(request);
        sendJson(response, 200, await characters.putTemplate(workId, fields as CharacterTemplate, expectedRevision as number));
      },
    },
  },
];
