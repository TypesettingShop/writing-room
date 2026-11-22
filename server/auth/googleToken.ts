import { request as requestHttp, type IncomingMessage } from 'node:http';
import { request as requestHttps } from 'node:https';
import { ApiError } from '../http/errors.js';
import type { GoogleIdentity } from './authStore.js';
import type { GoogleConfig } from './googleConfig.js';
import { matchesSecret, secureCookie } from './session.js';

const maxResponseBytes = 1024 * 1024;
const timeoutMs = 10_000;
const googleIssuers = new Set(['accounts.google.com', 'https://accounts.google.com']);

async function readTokenResponse(response: IncomingMessage): Promise<unknown> {
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300 || Number(response.headers['content-length']) > maxResponseBytes) {
    response.destroy();
    throw new Error('Unexpected token response.');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maxResponseBytes) {
      response.destroy();
      throw new Error('Token response exceeded the size limit.');
    }
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
}

export async function exchangeGoogleCode(config: GoogleConfig, code: string, verifier: string, redirectUri: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(config.tokenEndpoint);
    // The configured Google endpoint uses HTTPS. Loopback HTTP serves the in-process test provider.
    if (url.protocol !== 'https:' && secureCookie(url.origin, true)) {
      throw new Error('Invalid token endpoint.');
    }
    const transport = url.protocol === 'https:' ? requestHttps : requestHttp;
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
      client_id: config.clientId, client_secret: config.clientSecret,
    }).toString();
    // Node's request does not follow redirects and aborts the socket even while the response body is streaming.
    return await new Promise<unknown>((resolve, reject) => {
      const request = transport(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'identity',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        signal: controller.signal,
      }, response => {
        readTokenResponse(response).then(resolve, reject);
      });
      request.once('error', reject);
      request.end(body);
    });
  } catch {
    throw new ApiError(502, 'google_unavailable', 'Google sign-in could not be completed.');
  } finally {
    clearTimeout(timeout);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readClaims(payload: unknown): Record<string, unknown> | undefined {
  if (!record(payload) || typeof payload.id_token !== 'string') {
    return undefined;
  }
  const parts = payload.id_token.split('.');
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[1], 'base64url')));
    return record(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

export function validateGoogleIdentity(payload: unknown, clientId: string, nonce: string, now: number): GoogleIdentity {
  // OIDC Core §3.1.3.7 allows issuer authentication by TLS on a direct token-endpoint exchange.
  // Only call this with the response from exchangeGoogleCode.
  const claims = readClaims(payload);
  const audience = claims?.aud;
  const correctAudience = audience === clientId || (Array.isArray(audience) && audience.length === 1 && audience[0] === clientId);
  if (!claims || typeof claims.iss !== 'string' || !googleIssuers.has(claims.iss) || !correctAudience ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= now / 1000 ||
      !matchesSecret(typeof claims.nonce === 'string' ? claims.nonce : undefined, nonce) ||
      typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) {
    throw new ApiError(401, 'invalid_google_identity', 'Google sign-in could not be verified.');
  }
  // Both verified and unverified emails are display data. The subject is the account key.
  const email = typeof claims.email_verified === 'boolean' && typeof claims.email === 'string' &&
    claims.email.length <= 508 && !/[\0\p{Surrogate}]/u.test(claims.email) ? claims.email : null;
  return { subject: claims.sub, email };
}
