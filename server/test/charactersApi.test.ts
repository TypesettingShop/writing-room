// @vitest-environment node

import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CharacterNodeChange } from '../../src/platform/characters/common/charactersStore.js';
import { InMemoryCharactersRepository } from '../../src/platform/characters/common/inMemoryCharactersStore.js';
import {
  charactersStoreContract, fillCharacterTree, fillCharacterValues,
} from '../../src/platform/characters/test/common/charactersStoreContract.js';
import { InMemoryManuscriptRepository } from '../../src/platform/manuscript/common/inMemoryManuscriptStore.js';
import { contractOwner } from '../../src/platform/manuscript/test/common/manuscriptStoreContract.js';
import { startTestApi, testOrigin } from './apiFixture.js';
import { httpCharactersStore } from './httpCharactersStore.js';
import { httpContractStore } from './httpContractStore.js';

describe('characters API', () => {
  let api: Awaited<ReturnType<typeof startTestApi>>;
  let repository: InMemoryManuscriptRepository;
  let charactersRepository: InMemoryCharactersRepository;
  const headers = { 'X-Test-User': 'owner', Origin: testOrigin };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  beforeEach(async () => {
    repository = new InMemoryManuscriptRepository();
    charactersRepository = new InMemoryCharactersRepository(userId => repository.workAccess(userId));
    api = await startTestApi({ repository, charactersRepository, store: 'memory' });
  });
  afterEach(async () => api.close());

  charactersStoreContract('HTTP over memory', () => ({
    owner: httpCharactersStore(api.fetch, 'owner'),
    other: httpCharactersStore(api.fetch, 'other'),
    ownerWorks: httpContractStore(api.fetch, 'owner'),
    otherWorks: httpContractStore(api.fetch, 'other'),
    seedFullWork: workId => fillCharacterTree(charactersRepository.forUser(contractOwner), workId),
    seedValuesBudget: workId => fillCharacterValues(charactersRepository.forUser(contractOwner), workId),
  }));

  async function workPath() {
    const { id } = await httpContractStore(api.fetch, 'owner').createWork({ title: 'Characters' });
    return '/api/works/' + id;
  }

  function rawGet(path: string, host = '127.0.0.1') {
    return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: api.port, path, headers: { ...headers, Host: host } }, incoming => {
        let body = '';
        incoming.setEncoding('utf8').on('data', chunk => { body += chunk; });
        incoming.on('end', () => resolve({ status: incoming.statusCode, body }));
      });
      req.on('error', reject).end();
    });
  }

  it('applies the same Origin, auth and Host gates as the manuscript routes', async () => {
    const base = (await workPath()) + '/characters';
    for (const originHeaders of [{ 'X-Test-User': 'owner' }, { ...headers, Origin: 'https://other.example' }]) {
      const response = await api.fetch(base + '/nodes', { method: 'POST', headers: originHeaders });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden_origin' } });
    }
    const anonymous = await api.fetch(base + '/tree');
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const host = await rawGet(base + '/tree', 'untrusted.example');
    expect(host.status).toBe(403);
    expect(JSON.parse(host.body)).toMatchObject({ error: { code: 'forbidden_host' } });
    expect((await rawGet(base + '/tree', new URL(testOrigin).host)).status).toBe(200);
  });

  it('matches the raw request target and UUID segments', async () => {
    const base = (await workPath()) + '/characters';
    for (const path of [base + '/nodes/bad-id', base + '/nodes/../tree', base + '/nodes/%2e%2e/tree']) {
      const response = await rawGet(path);
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'not_found' } });
    }
    const wrongMethod = await api.fetch(base + '/tree', { method: 'POST', headers });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('Allow')).toBe('GET');
  });

  it('keeps node routes separate and requires one valid revision on DELETE', async () => {
    const work = await workPath();
    const base = work + '/characters';
    const input = { kind: 'character', parentId: null, title: 'New', expectedRevision: 0 };
    function create(path: string, kind: string) {
      return api.fetch(path + '/nodes', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ...input, kind }) });
    }
    expect((await create(work, 'character')).status).toBe(400);
    expect((await create(base, 'document')).status).toBe(400);
    const created = await create(base, 'character');
    expect(created.status).toBe(201);
    const { node } = await created.json() as CharacterNodeChange;
    expect(node).toMatchObject({ kind: 'character', title: 'New', type: 'unknown' });
    const path = base + '/nodes/' + node.id;
    for (const suffix of ['', '?expectedRevision=1&expectedRevision=1', '?expectedRevision=abc', '?expectedRevision=9007199254740992']) {
      const response = await api.fetch(path + suffix, { method: 'DELETE', headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid' } });
    }
    const deleted = await api.fetch(path + '?expectedRevision=1', { method: 'DELETE', headers });
    expect(await deleted.json()).toEqual({ revision: 2, deletedCharacterIds: [node.id] });
    expect(await (await api.fetch(work + '/tree', { headers })).json()).toEqual({ revision: 0, nodes: [] });
  });

  it('reports an unavailable character repository after authenticating the request', async () => {
    const withoutCharacters = await startTestApi({ repository, store: 'postgres' });
    try {
      const path = (await workPath()) + '/characters/tree';
      expect((await withoutCharacters.fetch(path)).status).toBe(401);
      const response = await withoutCharacters.fetch(path, { headers });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
    } finally {
      await withoutCharacters.close();
    }
  });
});
