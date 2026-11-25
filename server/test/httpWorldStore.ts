import type { ManuscriptFetch } from '../../src/workbench/services/manuscript/browser/httpManuscriptStore.js';
import { ManuscriptStatus } from '../../src/workbench/services/manuscript/browser/windowManuscriptService.js';
import { HttpWorldStore } from '../../src/workbench/services/world/browser/httpWorldStore.js';
import { testOrigin } from './apiFixture.js';

export function httpWorldStore(fetcher: ManuscriptFetch, user: string): HttpWorldStore {
  return new HttpWorldStore(new ManuscriptStatus(), (path, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Origin', testOrigin);
    headers.set('X-Test-User', user);
    return fetcher(path, { ...init, headers });
  });
}
