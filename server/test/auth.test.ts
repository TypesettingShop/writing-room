// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryManuscriptRepository } from '../../src/platform/manuscript/common/inMemoryManuscriptStore.js';
import type { ManuscriptRepository } from '../../src/platform/manuscript/common/manuscriptStore.js';
import { AttemptLimit } from '../auth/attemptLimit.js';
import type { AuthOptions } from '../auth/authRoutes.js';
import { MemoryAuthStore, type AuthStore } from '../auth/authStore.js';
import { PostgresAuthStore } from '../auth/postgresAuthStore.js';
import { newSession } from '../auth/session.js';
import { readApiConfig } from '../config.js';
import { migrate } from '../store/migrate.js';
import manuscriptMigration from '../store/migrations/0001_manuscript.sql?raw';
import { createPostgresPool, PostgresManuscriptRepository } from '../store/postgresManuscriptRepository.js';
import { startTestApi, testOrigin } from './apiFixture.js';

const databaseUrl = process.env.WRITING_ROOM_TEST_DATABASE_URL;
const email = 'author@example.test';
const password = '  글쓰기🔑123  ';
const sessionMs = 30 * 24 * 60 * 60 * 1000;
const start = Date.UTC(2026, 10, 22);

function readSessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  expect(header).toMatch(/^wr_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000(?:; Secure)?$/);
  return header!.split(';', 1)[0];
}

function authFixture(store: 'memory' | 'postgres', fixture: () => { auth: AuthStore; repository: ManuscriptRepository }) {
  let api: Awaited<ReturnType<typeof startTestApi>> | undefined;
  let now: number;
  async function startApi(origin = testOrigin, options: Partial<AuthOptions> = {}) {
    const { auth, repository } = fixture();
    now = start;
    api = await startTestApi({
      store, repository, authenticate: undefined, allowedOrigins: [origin],
      accountAuth: { store: auth, allowLoopbackHttpCookies: true, trustProxy: false, now: () => now, ...options },
    });
    function get(path: string, cookie = '') {
      return api!.fetch(path, { headers: { cookie } });
    }
    function post(path: string, data: unknown, cookie = '', headers: Record<string, string> = {}) {
      return api!.fetch(path, {
        method: 'POST', headers: { origin, 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify(data),
      });
    }
    return { get, post };
  }
  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  it('normalizes email, keeps password whitespace, rotates sessions and revokes on logout', async () => {
    const { post, get } = await startApi();
    const signup = await post('/api/auth/signup', { email: '  AUTHOR@Example.Test ', password });
    expect(signup.status).toBe(201);
    expect(signup.headers.get('set-cookie')).not.toContain('Secure');
    const first = readSessionCookie(signup);
    const signedUp = await signup.json();
    expect(signedUp).toEqual({ user: { id: expect.any(String), email } });
    expect(await (await get('/api/auth/me', first)).json()).toEqual(signedUp);

    const duplicate = await post('/api/auth/signup', { email, password });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { message: 'An account with this email already exists.' } });
    const wrong = await post('/api/auth/login', { email, password: password.trim() });
    const missing = await post('/api/auth/login', { email: 'missing@example.test', password });
    expect([wrong.status, missing.status]).toEqual([401, 401]);
    expect(await wrong.json()).toEqual(await missing.json());
    const login = await post('/api/auth/login', { email, password }, first);
    expect(login.status).toBe(200);
    const fresh = readSessionCookie(login);
    expect(fresh).not.toBe(first);

    const blockedLogout = await post('/api/auth/logout', undefined, fresh, { origin: 'https://other.example.test' });
    expect(blockedLogout.status).toBe(403);
    expect((await get('/api/auth/me', fresh)).status).toBe(200);
    const logout = await post('/api/auth/logout', undefined, fresh);
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toBe('wr_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    expect((await get('/api/auth/me', fresh)).status).toBe(401);
    expect((await get('/api/auth/me', first)).status).toBe(200);
  }, 15_000);

  it('scopes real API requests to the signed-in owner and rejects expired cookies', async () => {
    const { get, post } = await startApi();
    const [owner, other] = await Promise.all([
      post('/api/auth/signup', { email: 'owner@example.test', password }).then(readSessionCookie),
      post('/api/auth/signup', { email: 'other@example.test', password }).then(readSessionCookie),
    ]);
    expect((await get('/api/works')).status).toBe(401);
    expect((await post('/api/works', { title: '사적인 원고' })).status).toBe(401);
    const created = await post('/api/works', { title: '사적인 원고' }, owner);
    expect(created.status).toBe(201);
    const { work } = await created.json() as { work: { id: string } };
    expect((await get('/api/works/' + work.id, owner)).status).toBe(200);
    expect((await get('/api/works/' + work.id, other)).status).toBe(404);
    const otherWorks = await get('/api/works', other);
    expect(otherWorks.status).toBe(200);
    expect(await otherWorks.json()).toEqual({ works: [] });
    now = start + sessionMs - 1;
    expect((await get('/api/auth/me', owner)).status).toBe(200);
    now++;
    expect((await get('/api/auth/me', owner)).status).toBe(401);
    expect((await get('/api/works', owner)).status).toBe(401);
  }, 15_000);

  it('creates one account and one session when the same email signs up concurrently', async () => {
    const { post } = await startApi();
    const results = await Promise.all([
      post('/api/auth/signup', { email: 'race@example.test', password }),
      post('/api/auth/signup', { email: 'RACE@example.test', password }),
    ]);
    expect(results.map(response => response.status).sort()).toEqual([201, 409]);
    expect(results.filter(response => response.headers.has('set-cookie'))).toHaveLength(1);
  }, 15_000);

  return startApi;
}

describe('email authentication with memory storage', () => {
  const startApi = authFixture('memory', () => ({
    auth: new MemoryAuthStore(), repository: new InMemoryManuscriptRepository(),
  }));

  it('checks Origin and password code points and sets Secure for non-loopback origins', async () => {
    const { post } = await startApi('https://app.example.test');
    expect((await post('/api/auth/login', { email, password }, '', { origin: 'https://else.example.test' })).status).toBe(403);
    expect((await post('/api/auth/signup', { email, password: '😀'.repeat(7) })).status).toBe(400);
    expect((await post('/api/auth/signup', { email, password: '😀'.repeat(257) })).status).toBe(400);
    const registered = await post('/api/auth/signup', { email, password: '😀'.repeat(256) });
    expect(registered.status).toBe(201);
    expect(registered.headers.get('set-cookie')).toContain('; Secure');
  });

  it('shares the fixed attempt window across signup and login and ignores forwarded addresses by default', async () => {
    const { post } = await startApi();
    for (let attempt = 0; attempt < 9; attempt++) {
      expect((await post('/api/auth/signup', { email, password: '' })).status).toBe(400);
    }
    expect((await post('/api/auth/login', { email, password })).status).toBe(401);
    const limited = await post('/api/auth/login', { email: 'AUTHOR@EXAMPLE.TEST', password }, '', { 'x-forwarded-for': '192.0.2.1' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('900');
    expect((await post('/api/auth/signup', { email: 'different@example.test', password: '' })).status).toBe(400);
  });

  it('uses the trusted proxy’s appended address when enabled', async () => {
    const { post } = await startApi(testOrigin, { trustProxy: true });
    const body = { email, password: '' };
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await post('/api/auth/signup', body, '', { 'x-forwarded-for': '192.0.2.1' })).status).toBe(400);
    }
    expect((await post('/api/auth/signup', body, '', { 'x-forwarded-for': '192.0.2.2, 192.0.2.1' })).status).toBe(429);
    expect((await post('/api/auth/signup', body, '', { 'x-forwarded-for': '192.0.2.2' })).status).toBe(400);
  });
});

describe.skipIf(!databaseUrl)('email authentication with PostgreSQL storage', () => {
  let admin: Pool;
  let pool: Pool;
  const schema = 'test_auth_' + randomUUID().replaceAll('-', '');
  const legacyUserId = randomUUID();
  const startApi = authFixture('postgres', () => ({
    auth: new PostgresAuthStore(pool), repository: new PostgresManuscriptRepository(pool),
  }));

  beforeAll(async () => {
    admin = createPostgresPool(databaseUrl!, 2);
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPostgresPool(databaseUrl!, 10, '-c search_path=' + schema);
    await migrate(pool, [{ version: '0001', sql: manuscriptMigration }]);
    await pool.query('INSERT INTO users (id) VALUES ($1)', [legacyUserId]);
    await migrate(pool);
  }, 25_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      try {
        await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      } finally {
        await admin.end();
      }
    }
  });

  it('keeps existing users and stores only the one-way password and session digests', async () => {
    const { post, get } = await startApi();
    const signup = await post('/api/auth/signup', { email: 'digests@example.test', password });
    const cookie = readSessionCookie(signup);
    const token = cookie.slice('wr_session='.length);
    const { user } = await signup.json() as { user: { id: string; email: string } };
    const { rows: [record] } = await pool.query(
      'SELECT email_normalized, password_hash FROM users WHERE id = $1', [user.id],
    );
    expect(record.email_normalized).toBe(user.email);
    expect(record.password_hash).toMatch(/^scrypt\$15\$8\$3\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/);
    expect(record.password_hash).not.toContain(password);
    const { rows: [session] } = await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [user.id]);
    expect(session.token_hash).toEqual(createHash('sha256').update(token).digest());
    expect((await pool.query('SELECT email, password_hash FROM users WHERE id = $1', [legacyUserId])).rows)
      .toEqual([{ email: null, password_hash: null }]);
    expect((await get('/api/auth/me', cookie)).status).toBe(200);
  });

  it('rolls back signup when its session cannot be written and prunes expired rows', async () => {
    const store = new PostgresAuthStore(pool);
    const a = newSession(start).session;
    const b = newSession(start).session;
    const user = await store.register('existing@example.test', 'test-format', a);
    await expect(store.register('rollback@example.test', 'test-format', a)).rejects.toThrow();
    expect(await store.findPasswordUser('rollback@example.test')).toBeUndefined();
    await store.createSession(user!.id, { ...b, createdAt: a.expiresAt });
    expect((await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [user!.id])).rows)
      .toEqual([{ token_hash: b.tokenHash }]);
    await store.deleteExpiredSessions(b.expiresAt);
    expect((await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [user!.id])).rows).toEqual([]);
  });
});

it('bounds the fixed-window map and restores access at the expiry boundary', () => {
  const limits = new AttemptLimit();
  for (let attempt = 0; attempt < 10; attempt++) {
    expect(limits.take('ip', email, start)).toBeUndefined();
  }
  expect(limits.take('ip', email, start + 899_999)).toBe(1);
  expect(limits.take('ip', email, start + 900_000)).toBeUndefined();
  for (let index = 0; index < 10_000; index++) {
    limits.take('ip', `author${index}@example.test`, start + 900_000);
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    expect(limits.take('ip', email, start + 900_000)).toBeUndefined();
  }
  expect(limits.take('ip', email, start + 900_000)).toBe(900);
});

it('preserves explicit loopback dev auth and defaults to Secure outside loopback development', () => {
  const env = { WRITING_ROOM_STORE: 'memory' };
  expect(readApiConfig(env)).toMatchObject({ trustProxy: false, allowLoopbackHttpCookies: true });
  expect(readApiConfig({ ...env, NODE_ENV: 'production' }).allowLoopbackHttpCookies).toBe(false);
  expect(readApiConfig({ ...env, WRITING_ROOM_API_HOST: '0.0.0.0' }).allowLoopbackHttpCookies).toBe(false);
  expect(() => readApiConfig({ ...env, WRITING_ROOM_AUTH: 'dev', NODE_ENV: 'production' })).toThrow('non-production');
});
