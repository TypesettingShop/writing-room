import { HttpManuscriptStore, type ManuscriptFetch } from '../../src/workbench/services/manuscript/browser/httpManuscriptStore.js';
import { ManuscriptStatus } from '../../src/workbench/services/manuscript/browser/windowManuscriptService.js';
import { testOrigin } from './apiFixture.js';

export function httpContractStore(fetcher: ManuscriptFetch, user: string): HttpManuscriptStore {
  return new HttpManuscriptStore(new ManuscriptStatus(), (path, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Origin', testOrigin);
    headers.set('X-Test-User', user);
    return fetcher(path, { ...init, headers });
  });
}
