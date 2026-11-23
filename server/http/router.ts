import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CharactersStore } from '../../src/platform/characters/common/charactersStore.js';
import { isManuscriptId, ManuscriptStoreError } from '../../src/platform/manuscript/common/manuscript.js';
import type { ManuscriptStore } from '../../src/platform/manuscript/common/manuscriptStore.js';
import { ApiError } from './errors.js';

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  query: URLSearchParams;
  workId: string;
  nodeId: string;
  store: ManuscriptStore;
  characters: CharactersStore;
}

export interface Route<Context = RouteContext> {
  path: string;
  handlers: Readonly<Record<string, (context: Context) => Promise<void>>>;
}

export function splitTarget(request: IncomingMessage): { path: string; query: URLSearchParams } {
  const target = request.url ?? '';
  const index = target.indexOf('?');
  return index === -1
    ? { path: target, query: new URLSearchParams() }
    : { path: target.slice(0, index), query: new URLSearchParams(target.slice(index + 1)) };
}

export function matchRoute<Context>(routes: readonly Route<Context>[], path: string, method: string, response: ServerResponse) {
  // Match the original request target. URL pathname normalization would collapse dot segments.
  const segments = path.split('/');
  for (const route of routes) {
    const pattern = route.path.split('/');
    if (pattern.length !== segments.length) {
      continue;
    }
    if (!pattern.every((part, index) => part.startsWith(':') ? isManuscriptId(segments[index]) : part === segments[index])) {
      continue;
    }
    if (!Object.hasOwn(route.handlers, method)) {
      response.setHeader('Allow', Object.keys(route.handlers).join(', '));
      throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
    }
    return {
      handler: route.handlers[method],
      workId: segments[pattern.indexOf(':workId')] ?? '',
      nodeId: segments[pattern.indexOf(':nodeId')] ?? '',
    };
  }
  throw new ManuscriptStoreError('not_found');
}
