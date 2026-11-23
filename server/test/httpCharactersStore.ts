import { HttpCharactersStore } from '../../src/workbench/services/characters/browser/httpCharactersStore.js';
import type { ManuscriptFetch } from '../../src/workbench/services/manuscript/browser/httpManuscriptStore.js';
import { ManuscriptStatus } from '../../src/workbench/services/manuscript/browser/windowManuscriptService.js';
import { testOrigin } from './apiFixture.js';

export function httpCharactersStore(fetcher: ManuscriptFetch, user: string): HttpCharactersStore {
  return new HttpCharactersStore(new ManuscriptStatus(), (path, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Origin', testOrigin);
    headers.set('X-Test-User', user);
    return fetcher(path, { ...init, headers });
  });
}
