// @vitest-environment node
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manuscriptLimits } from '../../src/platform/manuscript/common/manuscript.js';
import { InMemoryManuscriptRepository } from '../../src/platform/manuscript/common/inMemoryManuscriptStore.js';
import { contractTime, manuscriptStoreContract } from '../../src/platform/manuscript/test/common/manuscriptStoreContract.js';
import { readApiConfig } from '../config.js';
import { startTestApi, testOrigin } from './apiFixture.js';
import { httpContractStore } from './httpContractStore.js';

describe('in-memory API', () => {
  let api: Awaited<ReturnType<typeof startTestApi>>;
  const headers = { 'X-Test-User': 'owner', Origin: testOrigin };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  beforeEach(async () => {
    api = await startTestApi({ repository: new InMemoryManuscriptRepository(() => contractTime), store: 'memory' });
  });
  afterEach(async () => api.close());

  manuscriptStoreContract('HTTP manuscript contract', async () => ({
    owner: httpContractStore(api.fetch, 'owner'),
    other: httpContractStore(api.fetch, 'other'),
  }));

  it('requires an allowed Origin for writes, sets response headers and authenticates reads', async () => {
    for (const origin of [undefined, 'https://other.example']) {
      const response = await api.fetch('/api/works', {
        method: 'POST', headers: origin ? { ...jsonHeaders, Origin: origin } : { 'X-Test-User': 'owner' },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden_origin' } });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    expect((await api.fetch('/api/works')).status).toBe(401);
    expect(await (await api.fetch('/api/health')).json()).toEqual({ ok: true, store: 'memory' });
  });

  it('matches raw request targets without path normalization', async () => {
    for (const path of ['/api/works/bad-id', '/api/works/../works', '/api/works/%2F', '/api/works//tree']) {
      const response = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: api.port, path, headers }, incoming => {
          let body = '';
          incoming.setEncoding('utf8').on('data', chunk => { body += chunk; });
          incoming.on('end', () => resolve({ status: incoming.statusCode, body }));
        });
        req.on('error', reject).end();
      });
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({ error: { code: 'not_found', message: 'Manuscript resource not found.' } });
    }
    const wrongMethod = await api.fetch('/api/works', { method: 'DELETE', headers });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('Allow')).toBe('GET, POST');
  });

  it('rejects malformed JSON, media types and invalid document UTF-8', async () => {
    const invalidJson = await api.fetch('/api/works', { method: 'POST', headers: jsonHeaders, body: '{' });
    const invalidType = await api.fetch('/api/works', { method: 'POST', headers, body: '{}' });
    expect(invalidJson.status).toBe(400);
    expect(invalidType.status).toBe(415);
    const store = httpContractStore(api.fetch, 'owner');
    const { id } = await store.createWork({ title: 'Work' });
    const { node } = await store.createNode(id, { kind: 'document', parentId: null, title: '' }, 0);
    const response = await api.fetch('/api/works/' + id + '/documents/' + node.id, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'text/markdown' }, body: Uint8Array.of(0xc0, 0xaf),
    });
    expect(response.status).toBe(400);
    expect((await store.readDocument(id, node.id)).content).toBe('');
  });

  it('checks the declared Markdown size before reading its body', async () => {
    const store = httpContractStore(api.fetch, 'owner');
    const { id } = await store.createWork({ title: 'Work' });
    const { node } = await store.createNode(id, { kind: 'document', parentId: null, title: '' }, 0);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: api.port, path: '/api/works/' + id + '/documents/' + node.id, method: 'PUT',
        headers: { ...headers, 'Content-Type': 'text/markdown', 'Content-Length': manuscriptLimits.document + 1 },
      }, response => {
        response.resume();
        response.on('end', () => { resolve(response.statusCode); req.destroy(); });
      });
      req.setTimeout(2000, () => req.destroy(new Error('No 413 before the body arrived.')));
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
    expect(await store.readDocument(id, node.id)).toMatchObject({ content: '', size: 0 });
  });

  it('rejects a chunked body as soon as it crosses the limit', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: api.port, path: '/api/works', method: 'POST', headers: jsonHeaders },
        response => {
          response.resume();
          response.on('end', () => { resolve(response.statusCode); req.destroy(); });
        });
      req.setTimeout(2000, () => req.destroy(new Error('No 413 before the sender finished.')));
      req.on('error', reject);
      req.write(Buffer.alloc(1024 * 1024, 0x20));
      req.write(' ');
      // Deliberately leave the request body open until the response arrives.
    });
    expect(status).toBe(413);
    expect((await api.fetch('/api/health')).status).toBe(200);
  });
});

it('catches an unexpected handler exception without leaking it or stopping the API', async () => {
  const logError = vi.fn();
  const api = await startTestApi({
    repository: new InMemoryManuscriptRepository(), store: 'memory', logError,
    authenticate: () => { throw new Error('a secret'); },
  });
  try {
    const response = await api.fetch('/api/works');
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'internal' } });
    expect(logError).toHaveBeenCalledWith('Unexpected failure handling an API request.');
    expect((await api.fetch('/api/health')).status).toBe(200);
  } finally {
    await api.close();
  }
});

it('requires explicit storage and refuses development authentication outside loopback or in production', () => {
  const memory = { WRITING_ROOM_STORE: 'memory', WRITING_ROOM_AUTH: 'dev' };
  expect(() => readApiConfig({})).toThrow('WRITING_ROOM_STORE');
  expect(() => readApiConfig({ ...memory, WRITING_ROOM_API_HOST: '0.0.0.0' })).toThrow('loopback');
  expect(() => readApiConfig({ ...memory, NODE_ENV: 'production' })).toThrow('non-production');
  expect(readApiConfig(memory)).toMatchObject({ port: 8787, host: '127.0.0.1', store: 'memory', auth: 'dev' });
});
