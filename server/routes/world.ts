import type { NodeDestination } from '../../src/platform/manuscript/common/manuscriptStore.js';
import type { Calendar } from '../../src/platform/world/common/calendar.js';
import { WorldStoreError } from '../../src/platform/world/common/world.js';
import type { CreateWorldNode, UpdateWorldNode } from '../../src/platform/world/common/worldStore.js';
import { readJson } from '../http/body.js';
import { sendJson } from '../http/errors.js';
import type { Route } from '../http/router.js';

const prefix = '/api/works/:workId/world';

export const worldRoutes: readonly Route[] = [
  {
    path: prefix + '/tree',
    handlers: {
      GET: async ({ response, world, workId }) => sendJson(response, 200, await world.getTree(workId)),
    },
  },
  {
    path: prefix + '/preset',
    handlers: {
      POST: async ({ request, response, world, workId }) => {
        const { presetId, expectedRevision } = await readJson(request);
        sendJson(response, 200, await world.applyPreset(workId, presetId as string, expectedRevision as number));
      },
    },
  },
  {
    path: prefix + '/nodes',
    handlers: {
      POST: async ({ request, response, world, workId }) => {
        // The shared tree editor validates the contents after checking work ownership and revision.
        const { expectedRevision, ...input } = await readJson(request);
        sendJson(response, 201, await world.createNode(workId, input as unknown as CreateWorldNode, expectedRevision as number));
      },
    },
  },
  {
    path: prefix + '/nodes/move',
    handlers: {
      POST: async ({ request, response, world, workId }) => {
        const { nodeIds, expectedRevision, ...destination } = await readJson(request);
        sendJson(response, 200, await world.moveNodes(
          workId, nodeIds as string[], destination as unknown as NodeDestination, expectedRevision as number,
        ));
      },
    },
  },
  {
    path: prefix + '/nodes/:nodeId',
    handlers: {
      PATCH: async ({ request, response, world, workId, nodeId }) => {
        const { expectedRevision, ...input } = await readJson(request);
        sendJson(response, 200, await world.updateNode(workId, nodeId, input as UpdateWorldNode, expectedRevision as number));
      },
      DELETE: async ({ response, query, world, workId, nodeId }) => {
        const [expected, ...duplicates] = query.getAll('expectedRevision');
        if (!expected || /[^0-9]/.test(expected) || duplicates.length) {
          throw new WorldStoreError('invalid');
        }
        sendJson(response, 200, await world.deleteNode(workId, nodeId, Number(expected)));
      },
    },
  },
  {
    path: prefix + '/calendar',
    handlers: {
      GET: async ({ response, world, workId }) => sendJson(response, 200, await world.getCalendar(workId)),
      PUT: async ({ request, response, world, workId }) => {
        const { calendar, expectedRevision } = await readJson(request);
        sendJson(response, 200, await world.putCalendar(workId, calendar as Calendar, expectedRevision as number));
      },
    },
  },
];
