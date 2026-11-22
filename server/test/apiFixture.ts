import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { contractOther, contractOwner } from '../../src/platform/manuscript/test/common/manuscriptStoreContract.js';
import { createApiServer, type ApiOptions } from '../apiServer.js';

export const testOrigin = 'http://127.0.0.1:5173';

export async function startTestApi(options: Omit<ApiOptions, 'authenticate' | 'allowedOrigins'> & Partial<ApiOptions>) {
  const server: Server = createApiServer({
    allowedOrigins: [testOrigin],
    authenticate: request => {
      switch (request.headers['x-test-user']) {
        case 'owner': return contractOwner;
        case 'other': return contractOther;
        default: return undefined;
      }
    },
    ...options,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const base = 'http://127.0.0.1:' + port;
  return {
    port,
    fetch: (url: string, init?: RequestInit) => fetch(base + url, init),
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
