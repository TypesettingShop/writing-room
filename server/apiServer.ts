import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { CharactersRepository } from '../src/platform/characters/common/charactersStore.js';
import { ManuscriptStoreError } from '../src/platform/manuscript/common/manuscript.js';
import type { ManuscriptRepository } from '../src/platform/manuscript/common/manuscriptStore.js';
import { createAuthRoutes, type AuthOptions } from './auth/authRoutes.js';
import type { Authenticate } from './auth/devAuth.js';
import { sessionUser } from './auth/session.js';
import type { ApiConfig } from './config.js';
import { ApiError, sendError, sendJson } from './http/errors.js';
import { matchRoute, splitTarget } from './http/router.js';
import { characterRoutes } from './routes/characters.js';
import { workRoutes } from './routes/works.js';

const storageRoutes = [...workRoutes, ...characterRoutes];
const mutationMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const loopbackHostnames = new Set(['127.0.0.1', 'localhost', '[::1]']);

// A DNS-rebound page reaches the loopback listener under its own host name; reads have no Origin to check.
function isAllowedHost(host: string | undefined, allowedHosts: ReadonlySet<string>): boolean {
  const url = host ? URL.parse('http://' + host) : null;
  if (!url || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return false;
  }
  return loopbackHostnames.has(url.hostname) || allowedHosts.has(url.host);
}

export interface ApiOptions {
  repository: ManuscriptRepository;
  charactersRepository?: CharactersRepository;
  authenticate?: Authenticate;
  accountAuth?: AuthOptions;
  store: ApiConfig['store'];
  allowedOrigins: readonly string[];
  logError?: (message: string) => void;
}

export function createApiServer(options: ApiOptions) {
  const logError = options.logError ?? console.error;
  const allowedHosts = new Set(options.allowedOrigins.map(origin => new URL(origin).host));
  const accountAuth = options.accountAuth;
  const authRoutes = accountAuth ? createAuthRoutes(accountAuth) : [];
  const now = accountAuth?.now ?? Date.now;

  function checkOrigin(request: IncomingMessage, method: string): void {
    if (mutationMethods.has(method) && !options.allowedOrigins.includes(request.headers.origin ?? '')) {
      throw new ApiError(403, 'forbidden_origin', 'Origin is required and must be allowed.');
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!isAllowedHost(request.headers.host, allowedHosts)) {
        throw new ApiError(403, 'forbidden_host', 'Host must be a loopback address or an allowed origin.');
      }
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
      if (path.startsWith('/api/auth/')) {
        const { handler } = matchRoute(authRoutes, path, method, response);
        checkOrigin(request, method);
        await handler({ request, response, query });
        return;
      }

      const { handler, workId, nodeId } = matchRoute(storageRoutes, path, method, response);
      checkOrigin(request, method);
      const user = accountAuth && await sessionUser(accountAuth.store, request, new Date(now()));
      const userId = user?.id ?? await options.authenticate?.(request);
      if (!userId) {
        throw new ManuscriptStoreError('unauthorized');
      }
      await handler({
        request, response, workId, nodeId, query,
        get store() { return options.repository.forUser(userId); },
        get characters() {
          if (!options.charactersRepository) {
            throw new ApiError(503, 'unavailable', 'Character storage is unavailable.');
          }
          return options.charactersRepository.forUser(userId);
        },
      });
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
