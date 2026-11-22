import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ManuscriptStoreError } from '../src/platform/manuscript/common/manuscript.js';
import type { ManuscriptRepository } from '../src/platform/manuscript/common/manuscriptStore.js';
import type { Authenticate } from './auth/devAuth.js';
import type { ApiConfig } from './config.js';
import { ApiError, sendError, sendJson } from './http/errors.js';
import { matchRoute, splitTarget } from './http/router.js';
import { workRoutes } from './routes/works.js';

const mutationMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export interface ApiOptions {
  repository: ManuscriptRepository;
  authenticate: Authenticate;
  store: ApiConfig['store'];
  allowedOrigins: readonly string[];
  logError?: (message: string) => void;
}

export function createApiServer(options: ApiOptions) {
  const logError = options.logError ?? console.error;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const { path, query } = splitTarget(request);
      const method = request.method ?? '';
      if (path === '/api/health') {
        if (method !== 'GET') {
          response.setHeader('Allow', 'GET');
          throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
        }
        sendJson(response, 200, { ok: true, store: options.store });
        return;
      }
      const { handler, workId, nodeId } = matchRoute(workRoutes, path, method, response);
      if (mutationMethods.has(method) && !options.allowedOrigins.includes(request.headers.origin ?? '')) {
        throw new ApiError(403, 'forbidden_origin', 'Origin is required and must be allowed.');
      }
      const userId = await options.authenticate(request);
      if (!userId) {
        throw new ManuscriptStoreError('unauthorized');
      }
      const store = options.repository.forUser(userId);
      await handler({ request, response, store, workId, nodeId, query });
    } catch (error) {
      if (response.destroyed) {
        return;
      }
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!request.complete) {
        response.setHeader('Connection', 'close');
      }
      sendError(response, error, logError);
    }
  }
  return createServer((request, response) => {
    void handle(request, response);
  });
}
