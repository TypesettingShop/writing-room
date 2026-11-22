// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryManuscriptRepository } from '../../src/platform/manuscript/common/inMemoryManuscriptStore.js';
import type { ManuscriptRepository } from '../../src/platform/manuscript/common/manuscriptStore.js';
import { MemoryAuthStore, type AuthStore } from '../auth/authStore.js';
import { googleCallbackPath, googleStartPath, type GoogleConfig } from '../auth/googleConfig.js';
import { GoogleState } from '../auth/googleState.js';
import { PostgresAuthStore } from '../auth/postgresAuthStore.js';
import { newSecret } from '../auth/session.js';
import { readApiConfig } from '../config.js';
import { migrate } from '../store/migrate.js';
import { createPostgresPool, PostgresManuscriptRepository } from '../store/postgresManuscriptRepository.js';
import { startTestApi } from './apiFixture.js';

const clientId = 'test-google-client';
const clientSecret = 'test-google-secret';
const publicOrigin = 'http://localhost:5173';
const redirectUri = publicOrigin + googleCallbackPath;
const email = 'google-author@example.test';
const start = Date.UTC(2026, 10, 22);
const databaseUrl = process.env.WRITING_ROOM_TEST_DATABASE_URL;
type TokenResponse = 'oversized' | 'redirect' | 'stalled';

async function startFakeGoogle() {
  interface Authorization {
    options: Record<string, unknown>;
    mode?: TokenResponse;
  }
  const requested = new Map<string, Authorization>();
  const codes = new Map<string, Authorization & { challenge: string; nonce: string }>();
  const exchanges: URLSearchParams[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, publicOrigin);
    if (request.method === 'GET' && url.pathname === '/authorize') {
      const state = url.searchParams.get('state') ?? '';
      const authorization = requested.get(state);
      requested.delete(state);
      const challenge = url.searchParams.get('code_challenge');
      const nonce = url.searchParams.get('nonce');
      if (!authorization || !challenge || !nonce || url.searchParams.get('code_challenge_method') !== 'S256' ||
          url.searchParams.get('redirect_uri') !== redirectUri || url.searchParams.get('client_id') !== clientId) {
        response.writeHead(400).end();
        return;
      }
      const code = randomUUID();
      codes.set(code, { ...authorization, challenge, nonce });
      const location = new URL(redirectUri);
      location.search = new URLSearchParams({ code, state }).toString();
      response.writeHead(302, { Location: location.href }).end();
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/token') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    exchanges.push(body);
    const code = body.get('code') ?? '';
    const grant = codes.get(code);
    codes.delete(code);
    const verifier = body.get('code_verifier');
    if (!grant || !verifier || grant.challenge !== createHash('sha256').update(verifier).digest('base64url') ||
        body.get('client_secret') !== clientSecret || body.get('client_id') !== clientId ||
        body.get('grant_type') !== 'authorization_code' || body.get('redirect_uri') !== redirectUri) {
      response.writeHead(400).end();
      return;
    }
    if (grant.mode === 'redirect') {
      response.writeHead(307, { Location: '/token?redirected=1' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (grant.mode === 'oversized') {
      response.write(Buffer.alloc(1024 * 1024, ' '));
      response.end('{}');
      return;
    }
    if (grant.mode === 'stalled') {
      response.write('{');
      return;
    }
    const claims = {
      iss: 'https://accounts.google.com',
      aud: clientId,
      exp: start / 1000 + 3600,
      sub: 'google-subject',
      nonce: grant.nonce,
      email,
      email_verified: false,
      ...grant.options,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    response.end(JSON.stringify({ id_token: header + '.' + payload + '.fixture' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return {
    config: { clientId, clientSecret, publicOrigin, authorizationEndpoint: base + '/authorize', tokenEndpoint: base + '/token' },
    exchanges,
    async authorize(url: URL, options = {}, mode?: TokenResponse): Promise<URL> {
      requested.set(url.searchParams.get('state')!, { options, mode });
      const response = await fetch(url, { redirect: 'manual' });
      expect(response.status).toBe(302);
      return new URL(response.headers.get('location')!);
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

function firstCookie(response: Response, name: string): string {
  const cookie = response.headers.getSetCookie().find(header => header.startsWith(name + '='));
  expect(cookie).toBeDefined();
  return cookie!.split(';', 1)[0];
}

function googleFixture(store: 'memory' | 'postgres', fixture: () => { auth: AuthStore; repository: ManuscriptRepository }) {
  let api: Awaited<ReturnType<typeof startTestApi>> | undefined;
  let provider: Awaited<ReturnType<typeof startFakeGoogle>> | undefined;
  let now: number;
  async function open(enabled = true) {
    provider = enabled ? await startFakeGoogle() : undefined;
    const { auth, repository } = fixture();
    now = start;
    const server = await startTestApi({
      store, repository, authenticate: undefined, allowedOrigins: [publicOrigin],
      accountAuth: { store: auth, google: provider?.config, allowLoopbackHttpCookies: true, trustProxy: false, now: () => now },
    });
    api = server;
    async function begin(returnTo?: string) {
      const query = returnTo === undefined ? '' : '?' + new URLSearchParams({ returnTo }).toString();
      const response = await server.fetch(googleStartPath + query, { redirect: 'manual' });
      expect(response.status).toBe(302);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toMatch(/; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/);
      const url = new URL(response.headers.get('location')!);
      return { url, browser: firstCookie(response, 'wr_oauth_browser') };
    }
    function finish(url: URL, cookie = '') {
      return server.fetch(url.pathname + url.search, { redirect: 'manual', headers: { cookie } });
    }
    function user(cookie: string) {
      return server.fetch('/api/auth/me', { headers: { cookie } });
    }
    function signup() {
      return server.fetch('/api/auth/signup', {
        method: 'POST',
        headers: { origin: publicOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'test-author-password' }),
      });
    }
    return { begin, finish, user, signup, provider: provider!, fetch: server.fetch };
  }
  afterEach(async () => {
    await Promise.all([api?.close(), provider?.close()]);
    api = undefined;
    provider = undefined;
  });

  it('exchanges the code with PKCE and creates a separate account despite an unverified email match', async () => {
    const { begin, finish, provider, user, signup, fetch } = await open();
    expect(await (await fetch('/api/auth/providers')).json()).toEqual(['google']);
    const existing = await signup();
    expect(existing.status).toBe(201);
    const passwordAccount = await existing.json();
    const { url, browser } = await begin('/chapter?draft=1#heading');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.has('client_secret')).toBe(false);
    const callback = await provider.authorize(url);
    const response = await finish(callback, browser);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/chapter?draft=1#heading');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = firstCookie(response, 'wr_session');
    expect(provider.exchanges).toHaveLength(1);
    expect(provider.exchanges[0].get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const googleAccount = await (await user(cookie)).json();
    expect(googleAccount).toEqual({ user: { id: expect.any(String), email } });
    expect(googleAccount).not.toEqual(passwordAccount);
    expect(await (await user(firstCookie(existing, 'wr_session'))).json()).toEqual(passwordAccount);

    const repeat = await begin();
    const signedIn = await finish(await provider.authorize(repeat.url, { email_verified: true }), repeat.browser);
    expect(signedIn.headers.get('location')).toBe('/');
    const renewed = firstCookie(signedIn, 'wr_session');
    expect(renewed).not.toBe(cookie);
    expect(await (await user(renewed)).json()).toEqual(googleAccount);
  });

  return { open, moveClock: (value: number) => { now = value; } };
}

describe('Google authentication with memory storage and a fake provider', () => {
  const { open, moveClock } = googleFixture('memory', () => ({
    auth: new MemoryAuthStore(), repository: new InMemoryManuscriptRepository(),
  }));

  it('advertises no provider and leaves both Google routes unavailable without credentials', async () => {
    const { fetch } = await open(false);
    expect(await (await fetch('/api/auth/providers')).json()).toEqual([]);
    expect((await fetch(googleStartPath)).status).toBe(404);
    expect((await fetch(googleCallbackPath)).status).toBe(404);
  });

  it('requires the state in the starting browser, rejects replay and expires it at ten minutes', async () => {
    const { begin, finish, provider } = await open();
    const { url, browser } = await begin();
    const callback = await provider.authorize(url);
    const invalid = new URL(callback);
    invalid.searchParams.delete('state');
    expect((await finish(invalid, browser)).status).toBe(400);
    invalid.searchParams.set('state', newSecret());
    expect((await finish(invalid, browser)).status).toBe(400);
    expect((await finish(callback, 'wr_oauth_browser=' + newSecret())).status).toBe(400);
    expect((await finish(callback)).status).toBe(400);
    expect(provider.exchanges).toHaveLength(0);
    moveClock(start + 600_000 - 1);
    expect((await finish(callback, browser)).status).toBe(302);
    expect((await finish(callback, browser)).status).toBe(400);
    moveClock(start);
    const expiring = await begin();
    const expires = await provider.authorize(expiring.url);
    moveClock(start + 600_000);
    expect((await finish(expires, expiring.browser)).status).toBe(400);
    expect(provider.exchanges).toHaveLength(1);
  });

  it.each([
    { aud: 'other-client' },
    { iss: 'https://other.example.test' },
    { nonce: 'wrong-nonce' },
    { exp: start / 1000 },
    { sub: '' },
  ])('refuses a token with invalid claims %j', async claims => {
    const { begin, finish, provider } = await open();
    const { url, browser } = await begin();
    const callback = await provider.authorize(url, claims);
    const response = await finish(callback, browser);
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await finish(callback, browser)).status).toBe(400);
  });

  it.each(['//external.example.test', '/\\external.example.test', '/.//external.example.test', 'https://external.example.test'])(
    'rejects a non-local return path %j',
    async returnTo => {
      const { fetch } = await open();
      const response = await fetch(googleStartPath + '?' + new URLSearchParams({ returnTo }), { redirect: 'manual' });
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('set-cookie')).toBeNull();
    },
  );

  it('sends the fixed Works error location on cancellation and consumes the state', async () => {
    const { begin, finish, provider } = await open();
    const { url, browser } = await begin('/chapter');
    const callback = new URL(redirectUri);
    callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, error: 'access_denied' }).toString();
    const response = await finish(callback, browser);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?authError=google#works');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await finish(callback, browser)).status).toBe(400);
    expect(provider.exchanges).toHaveLength(0);
  });

  it.each(['oversized', 'redirect', 'stalled'] as const)('bounds the token exchange for a %s response', async mode => {
    const { begin, finish, provider } = await open();
    const { url, browser } = await begin();
    const callback = await provider.authorize(url, {}, mode);
    const response = await finish(callback, browser);
    expect(response.status).toBe(502);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(provider.exchanges).toHaveLength(1);
    expect(await response.json()).toEqual({
      error: { code: 'google_unavailable', message: 'Google sign-in could not be completed.' },
    });
  }, 18_000);
});

describe.skipIf(!databaseUrl)('Google authentication with PostgreSQL and a fake provider', () => {
  let admin: Pool;
  let pool: Pool;
  const schema = 'test_google_' + randomUUID().replaceAll('-', '');
  const { open } = googleFixture('postgres', () => ({
    auth: new PostgresAuthStore(pool), repository: new PostgresManuscriptRepository(pool),
  }));

  beforeAll(async () => {
    admin = createPostgresPool(databaseUrl!, 2);
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPostgresPool(databaseUrl!, 10, '-c search_path=' + schema);
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

  it('creates one durable identity for concurrent sign-ins with the same subject', async () => {
    const { begin, finish, provider, user } = await open();
    const subject = 'concurrent-subject';
    async function signIn() {
      const { url, browser } = await begin();
      const response = await finish(await provider.authorize(url, { sub: subject, email: 'concurrent@example.test' }), browser);
      expect(response.status).toBe(302);
      return firstCookie(response, 'wr_session');
    }
    const [first, second] = await Promise.all([signIn(), signIn()]);
    expect(first).not.toBe(second);
    const firstUser = await (await user(first)).json();
    expect(await (await user(second)).json()).toEqual(firstUser);
    const { rows } = await pool.query(`
      SELECT users.email, email_normalized, password_hash FROM users
      JOIN oauth_identities ON oauth_identities.user_id = users.id
      WHERE provider = 'google' AND subject = $1
    `, [subject]);
    expect(rows).toEqual([{ email: 'concurrent@example.test', email_normalized: null, password_hash: null }]);
    expect((await pool.query('SELECT id FROM users WHERE email = $1', ['concurrent@example.test'])).rowCount).toBe(1);
  });
});

it('bounds OAuth state and evicts the oldest entry when it is full', () => {
  const pending = new GoogleState();
  const browser = newSecret();
  const first = pending.issue(browser, '/', start);
  for (let index = 0; index < 9_999; index++) {
    pending.issue(browser, '/', start);
  }
  const last = pending.issue(browser, '/last', start);
  expect(pending.consume(first.state, browser, start)).toBeUndefined();
  expect(pending.consume(last.state, browser, start)?.returnTo).toBe('/last');
  expect(pending.consume(last.state, browser, start)).toBeUndefined();
});

it('enables Google only with credentials and one public origin and pins the real Google endpoints', () => {
  const memory = { WRITING_ROOM_STORE: 'memory' };
  const googleEnv = {
    WRITING_ROOM_GOOGLE_CLIENT_ID: clientId,
    WRITING_ROOM_GOOGLE_CLIENT_SECRET: clientSecret,
    WRITING_ROOM_PUBLIC_ORIGIN: publicOrigin,
  };
  expect(readApiConfig(memory).google).toBeUndefined();
  expect(() => readApiConfig({ ...memory, WRITING_ROOM_GOOGLE_CLIENT_ID: clientId })).toThrow('both');
  expect(() => readApiConfig({ ...memory, ...googleEnv, WRITING_ROOM_PUBLIC_ORIGIN: undefined })).toThrow('one HTTPS');
  expect(() => readApiConfig({ ...memory, ...googleEnv, WRITING_ROOM_PUBLIC_ORIGIN: publicOrigin + ', http://127.0.0.1:5173' })).toThrow('one HTTPS');
  expect(() => readApiConfig({ ...memory, ...googleEnv, NODE_ENV: 'production' })).toThrow('one HTTPS');
  expect(readApiConfig({ ...memory, ...googleEnv }).google).toEqual({
    clientId, clientSecret, publicOrigin,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
  } satisfies GoogleConfig);
});
