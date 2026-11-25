// @vitest-environment node

import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryManuscriptRepository } from '../../src/platform/manuscript/common/inMemoryManuscriptStore.js';
import { contractOwner } from '../../src/platform/manuscript/test/common/manuscriptStoreContract.js';
import { getGregorianCalendar } from '../../src/platform/world/common/calendar.js';
import { InMemoryWorldRepository } from '../../src/platform/world/common/inMemoryWorldStore.js';
import { fillWorldTree, fillWorldValues, worldStoreContract } from '../../src/platform/world/test/common/worldStoreContract.js';
import { startTestApi, testOrigin } from './apiFixture.js';
import { httpContractStore } from './httpContractStore.js';
import { httpWorldStore } from './httpWorldStore.js';

describe('world API', () => {
  let api: Awaited<ReturnType<typeof startTestApi>>;
  let repository: InMemoryManuscriptRepository;
  let worldRepository: InMemoryWorldRepository;
  let timestamp: number;
  const headers = { 'X-Test-User': 'owner', Origin: testOrigin };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  beforeEach(async () => {
    timestamp = 100;
    const now = () => timestamp;
    repository = new InMemoryManuscriptRepository(now);
    worldRepository = new InMemoryWorldRepository(id => repository.workAccess(id), now);
    api = await startTestApi({ repository, worldRepository, store: 'memory' });
  });
  afterEach(async () => api.close());

  worldStoreContract('HTTP over memory', () => ({
    owner: httpWorldStore(api.fetch, 'owner'),
    other: httpWorldStore(api.fetch, 'other'),
    ownerWorks: httpContractStore(api.fetch, 'owner'),
    otherWorks: httpContractStore(api.fetch, 'other'),
    advanceClock: () => { timestamp += 10; },
    seedFullWork: id => fillWorldTree(worldRepository.forUser(contractOwner), id),
    seedValuesBudget: id => fillWorldValues(worldRepository.forUser(contractOwner), id),
  }));

  async function createWork() {
    return httpContractStore(api.fetch, 'owner').createWork({ title: 'World API' });
  }

  it('shares the Host, Origin and authentication gates with manuscripts', async () => {
    const { id } = await createWork();
    const base = '/api/works/' + id + '/world';
    const nodeId = globalThis.crypto.randomUUID();
    for (const [method, path] of [
      ['POST', '/preset'], ['POST', '/nodes'], ['POST', '/nodes/move'],
      ['PATCH', '/nodes/' + nodeId], ['PUT', '/calendar'], ['DELETE', '/nodes/' + nodeId + '?expectedRevision=0'],
    ]) {
      const response = await api.fetch(base + path, { method, headers: { 'X-Test-User': 'owner' } });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden_origin' } });
      const anonymous = await api.fetch(base + path, { method, headers: { Origin: testOrigin } });
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ error: { code: 'unauthorized' } });
    }
    for (const path of ['/tree', '/calendar']) {
      const response = await api.fetch(base + path);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
    }
    const hostRejection = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: api.port, path: base + '/tree', headers: { ...headers, Host: 'untrusted.example' },
      }, response => {
        let body = '';
        response.setEncoding('utf8').on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      req.on('error', reject).end();
    });
    expect(hostRejection.status).toBe(403);
    expect(JSON.parse(hostRejection.body)).toMatchObject({ error: { code: 'forbidden_host' } });
  });

  it('returns not_found for invalid, inaccessible and absent resource IDs', async () => {
    const { id } = await createWork();
    const base = '/api/works/' + id + '/world';
    const nodeId = globalThis.crypto.randomUUID();
    for (const response of [
      await api.fetch('/api/works/bad-id/world/tree', { headers }),
      await api.fetch(base + '/calendar', { headers: { 'X-Test-User': 'other' } }),
      await api.fetch(base + '/nodes/bad-id?expectedRevision=0', { method: 'DELETE', headers }),
      await api.fetch(base + '/nodes/' + nodeId + '?expectedRevision=0', { method: 'DELETE', headers }),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('accepts only a single decimal revision on DELETE and leaves the manuscript tree alone', async () => {
    const { id } = await createWork();
    const workPath = '/api/works/' + id;
    const { node } = await httpWorldStore(api.fetch, 'owner').createNode(id, {
      kind: 'category', title: 'Place', parentId: null,
    }, 0);
    const path = workPath + '/world/nodes/' + node.id;
    for (const suffix of [
      '', '?expectedRevision=1&expectedRevision=1', '?expectedRevision=1.5',
      '?expectedRevision=abc', '?expectedRevision=1%0A', '?expectedRevision=9007199254740992',
    ]) {
      const response = await api.fetch(path + suffix, { method: 'DELETE', headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid' } });
    }
    const deleted = await api.fetch(path + '?expectedRevision=1', { method: 'DELETE', headers });
    expect(await deleted.json()).toEqual({ revision: 2, deletedNodeIds: [node.id] });
    expect(await (await api.fetch(workPath + '/tree', { headers })).json()).toEqual({ revision: 0, nodes: [] });
  });

  it('requires typed preset and calendar bodies', async () => {
    const { id } = await createWork();
    const base = '/api/works/' + id + '/world';
    const calendar = getGregorianCalendar();
    for (const [path, method, body] of [
      ['/preset', 'POST', { presetId: ['blank'], expectedRevision: 0 }],
      ['/preset', 'POST', { presetId: 'blank' }],
      ['/calendar', 'PUT', { calendar }],
      ['/calendar', 'PUT', { expectedRevision: 0 }],
    ] as const) {
      const response = await api.fetch(base + path, { method, headers: jsonHeaders, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid' } });
    }
    expect(await httpWorldStore(api.fetch, 'owner').getTree(id)).toEqual({ revision: 0, nodes: [] });
    expect(await httpWorldStore(api.fetch, 'owner').getCalendar(id)).toEqual({ revision: 0, calendar });
  });

  it('exposes manuscript routes and returns 404 for world routes without a world repository', async () => {
    const { id } = await createWork();
    const standalone = await startTestApi({ repository, store: 'memory' });
    try {
      const base = '/api/works/' + id;
      const response = await standalone.fetch(base + '/world/tree', { headers });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
      expect((await standalone.fetch(base + '/world/calendar')).status).toBe(404);
      expect(await (await standalone.fetch(base + '/tree', { headers })).json()).toEqual({ revision: 0, nodes: [] });
    } finally {
      await standalone.close();
    }
  });
});
