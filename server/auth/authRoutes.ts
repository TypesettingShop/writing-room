import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson } from '../http/body.js';
import { ApiError, sendJson } from '../http/errors.js';
import type { Route } from '../http/router.js';
import { AttemptLimit } from './attemptLimit.js';
import type { AuthStore } from './authStore.js';
import { clientAddressKey } from './clientAddress.js';
import type { GoogleConfig } from './googleConfig.js';
import { createGoogleRoutes } from './googleRoutes.js';
import { hashPassword, PasswordWorkQueueFull, verifyPassword } from './password.js';
import { endSession, newSession, secureCookie, sessionUser, writeSessionCookie } from './session.js';

export interface AuthRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  query: URLSearchParams;
}

export interface AuthOptions {
  store: AuthStore;
  trustProxy: boolean;
  allowLoopbackHttpCookies: boolean;
  now?: () => number;
  google?: GoogleConfig;
}

const attemptWindowMs = 15 * 60 * 1000;

async function passwordWork<T>(response: ServerResponse, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PasswordWorkQueueFull) {
      response.setHeader('Retry-After', 1);
      throw new ApiError(503, 'password_work_busy', 'Sign-in is busy. Try again shortly.');
    }
    throw error;
  }
}

export function createAuthRoutes(options: AuthOptions): readonly Route<AuthRouteContext>[] {
  const { store, trustProxy, allowLoopbackHttpCookies, now = Date.now } = options;
  const accountAttempts = new AttemptLimit(10, attemptWindowMs, 8_000);
  const addressAttempts = new AttemptLimit(60, attemptWindowMs, 2_000);

  async function credentials({ request, response }: AuthRouteContext) {
    const body = await readJson(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const at = email.indexOf('@');
    if (email.length > 508 || [...email].length > 254 || /[\0\p{Surrogate}]/u.test(email) || at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) {
      throw new ApiError(400, 'invalid_email', 'Enter a valid email address.');
    }
    const time = now();
    const retryAfter = addressAttempts.take(clientAddressKey(request, trustProxy), time) ?? accountAttempts.take(email, time);
    if (retryAfter !== undefined) {
      response.setHeader('Retry-After', retryAfter);
      throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Try again later.');
    }
    const password = typeof body.password === 'string' ? body.password : '';
    return { email, password, secure: secureCookie(request.headers.origin, allowLoopbackHttpCookies) };
  }

  function validPassword(password: string): boolean {
    if (password.length < 8 || password.length > 512 || /\p{Surrogate}/u.test(password)) {
      return false;
    }
    const length = [...password].length;
    return length >= 8 && length <= 256;
  }

  async function signup(context: AuthRouteContext): Promise<void> {
    const { response } = context;
    const { email, password, secure } = await credentials(context);
    if (!validPassword(password)) {
      throw new ApiError(400, 'invalid_password', 'Password must be 8 to 256 characters.');
    }
    const passwordHash = await passwordWork(response, () => hashPassword(password));
    const { token, session } = newSession(now());
    const user = await store.register(email, passwordHash, session);
    if (!user) {
      throw new ApiError(409, 'email_exists', 'An account with this email already exists.');
    }
    accountAttempts.reset(email);
    writeSessionCookie(response, token, secure);
    sendJson(response, 201, { user });
  }

  async function login(context: AuthRouteContext): Promise<void> {
    const { response } = context;
    const { email, password, secure } = await credentials(context);
    const valid = validPassword(password);
    const user = valid ? await store.findPasswordUser(email) : undefined;
    const matches = await passwordWork(response, () => verifyPassword(valid ? password : '', user?.passwordHash));
    if (!user || !matches) {
      throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    const { token, session } = newSession(now());
    await store.createSession(user.id, session);
    accountAttempts.reset(email);
    writeSessionCookie(response, token, secure);
    sendJson(response, 200, { user: { id: user.id, email: user.email } });
  }

  async function logout({ request, response }: AuthRouteContext): Promise<void> {
    await endSession(store, request, response, secureCookie(request.headers.origin, allowLoopbackHttpCookies));
    response.writeHead(204).end();
  }

  async function me({ request, response }: AuthRouteContext): Promise<void> {
    const user = await sessionUser(store, request, new Date(now()));
    if (!user) {
      throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    }
    sendJson(response, 200, { user });
  }

  return [
    { path: '/api/auth/signup', handlers: { POST: signup } },
    { path: '/api/auth/login', handlers: { POST: login } },
    { path: '/api/auth/logout', handlers: { POST: logout } },
    { path: '/api/auth/me', handlers: { GET: me } },
    ...createGoogleRoutes(options),
  ];
}
