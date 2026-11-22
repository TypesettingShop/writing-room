import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthStore, AuthUser, SessionRecord } from './authStore.js';

const sessionCookie = 'wr_session';
const sessionSeconds = 30 * 24 * 60 * 60;
const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function isSecret(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function matchesSecret(actual: string | null | undefined, expected: string): boolean {
  return isSecret(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function secureCookie(origin: string | undefined, allowLoopbackHttp: boolean): boolean {
  const url = origin ? URL.parse(origin) : null;
  return !(allowLoopbackHttp && url?.protocol === 'http:' && loopbackHostnames.has(url.hostname));
}

export function readCookie(request: IncomingMessage, name: string): string | undefined {
  let value: string | undefined;
  for (const field of request.headers.cookie?.split(';') ?? []) {
    const cookie = field.trimStart();
    if (cookie.startsWith(name + '=')) {
      if (value !== undefined) {
        return undefined;
      }
      value = cookie.slice(name.length + 1);
    }
  }
  return value;
}

export function setCookie(response: ServerResponse, name: string, value: string, maxAge: number, secure: boolean): void {
  response.appendHeader('Set-Cookie', `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

function readSessionHash(request: IncomingMessage): Buffer | undefined {
  const token = readCookie(request, sessionCookie);
  return isSecret(token) ? hashToken(token) : undefined;
}

export function newSession(now: number): { token: string; session: SessionRecord } {
  const token = newSecret();
  return {
    token,
    session: {
      tokenHash: hashToken(token),
      createdAt: new Date(now),
      expiresAt: new Date(now + sessionSeconds * 1000),
    },
  };
}

export function writeSessionCookie(response: ServerResponse, token: string, secure: boolean): void {
  setCookie(response, sessionCookie, token, sessionSeconds, secure);
}

export async function sessionUser(store: AuthStore, request: IncomingMessage, now: Date): Promise<AuthUser | undefined> {
  const hash = readSessionHash(request);
  if (hash) {
    const session = await store.findSession(hash, now);
    if (session && timingSafeEqual(hash, session.tokenHash)) {
      return session.user;
    }
  }
  return undefined;
}

export async function endSession(store: AuthStore, request: IncomingMessage, response: ServerResponse, secure: boolean): Promise<void> {
  const hash = readSessionHash(request);
  if (hash) {
    await store.deleteSession(hash);
  }
  setCookie(response, sessionCookie, '', 0, secure);
}
