import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { ApiError, sendJson } from '../http/errors.js';
import type { Route } from '../http/router.js';
import { AttemptLimit } from './attemptLimit.js';
import type { AuthOptions, AuthRouteContext } from './authRoutes.js';
import { clientAddressKey } from './clientAddress.js';
import { googleCallbackPath, googleStartPath } from './googleConfig.js';
import { GoogleState, googleStateSeconds } from './googleState.js';
import { exchangeGoogleCode, validateGoogleIdentity } from './googleToken.js';
import { isSecret, newSecret, newSession, readCookie, secureCookie, setCookie, writeSessionCookie } from './session.js';

const browserCookie = 'wr_oauth_browser';

function returnPath(value: string | null, origin: string): string {
  if (value === null) {
    return '/';
  }
  const target = URL.parse(value, origin);
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(value) ||
      !target || target.origin !== origin || target.pathname.startsWith('//')) {
    throw new ApiError(400, 'invalid_return_to', 'Enter a same-origin return path.');
  }
  return target.pathname + target.search + target.hash;
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { Location: location }).end();
}

export function createGoogleRoutes({ google, store, allowLoopbackHttpCookies, trustProxy, now = Date.now }: AuthOptions): Route<AuthRouteContext>[] {
  const providers: Route<AuthRouteContext> = {
    path: '/api/auth/providers',
    handlers: { GET: async ({ response }) => sendJson(response, 200, google ? ['google'] : []) },
  };
  if (!google) {
    return [providers];
  }
  const config = google;
  const redirectUri = config.publicOrigin + googleCallbackPath;
  const secure = secureCookie(config.publicOrigin, allowLoopbackHttpCookies);
  const pending = new GoogleState();
  const starts = new AttemptLimit(20, googleStateSeconds * 1000, 2_000);

  async function start({ request, response, query }: AuthRouteContext): Promise<void> {
    response.setHeader('Referrer-Policy', 'no-referrer');
    const time = now();
    const retryAfter = starts.take(clientAddressKey(request, trustProxy), time);
    if (retryAfter !== undefined) {
      response.setHeader('Retry-After', retryAfter);
      throw new ApiError(429, 'too_many_attempts', 'Too many Google sign-in attempts. Try again later.');
    }
    const returnTo = returnPath(query.get('returnTo'), config.publicOrigin);
    const existing = readCookie(request, browserCookie);
    const browser = isSecret(existing) ? existing : newSecret();
    const signIn = pending.issue(browser, returnTo, time);
    if (!signIn) {
      response.setHeader('Retry-After', 10);
      throw new ApiError(503, 'google_sign_in_busy', 'Google sign-in is busy. Try again shortly.');
    }
    const { state, verifier, nonce } = signIn;
    setCookie(response, browserCookie, browser, googleStateSeconds, secure);
    const url = new URL(config.authorizationEndpoint);
    const parameters = {
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    };
    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }
    redirect(response, url.href);
  }

  async function callback({ request, response, query }: AuthRouteContext): Promise<void> {
    response.setHeader('Referrer-Policy', 'no-referrer');
    const state = query.get('state');
    const signIn = isSecret(state) && query.getAll('state').length === 1
      ? pending.consume(state, readCookie(request, browserCookie), now())
      : undefined;
    if (!signIn) {
      throw new ApiError(400, 'invalid_oauth_state', 'Google sign-in expired or could not be verified.');
    }
    if (query.has('error')) {
      redirect(response, '/?authError=google#works');
      return;
    }
    const code = query.get('code');
    if (!code || query.getAll('code').length !== 1) {
      throw new ApiError(400, 'invalid_oauth_code', 'Google sign-in did not return a code.');
    }
    const payload = await exchangeGoogleCode(config, code, signIn.verifier, redirectUri);
    const time = now();
    const identity = validateGoogleIdentity(payload, config.clientId, signIn.nonce, time);
    const { token, session } = newSession(time);
    await store.signInWithGoogle(identity, session);
    writeSessionCookie(response, token, secure);
    redirect(response, signIn.returnTo);
  }

  return [
    providers,
    { path: googleStartPath, handlers: { GET: start } },
    { path: googleCallbackPath, handlers: { GET: callback } },
  ];
}
