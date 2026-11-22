import { secureCookie } from './session.js';

export const googleStartPath = '/api/auth/oauth/google/start';
export const googleCallbackPath = '/api/auth/oauth/google/callback';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export function readGoogleConfig(env: NodeJS.ProcessEnv, allowLoopbackHttpCookies: boolean): GoogleConfig | undefined {
  if (!env.WRITING_ROOM_GOOGLE_CLIENT_ID && !env.WRITING_ROOM_GOOGLE_CLIENT_SECRET) {
    return undefined;
  }
  // Values pasted from the console often carry a trailing newline; Google would reject them as sent.
  const clientId = env.WRITING_ROOM_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.WRITING_ROOM_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Google sign-in requires both WRITING_ROOM_GOOGLE_CLIENT_ID and WRITING_ROOM_GOOGLE_CLIENT_SECRET.');
  }
  const publicOrigin = env.WRITING_ROOM_PUBLIC_ORIGIN?.trim() ?? '';
  const origin = URL.parse(publicOrigin);
  if (!origin || origin.origin !== publicOrigin || (origin.protocol !== 'https:' && secureCookie(publicOrigin, allowLoopbackHttpCookies))) {
    throw new Error('Google sign-in requires one HTTPS WRITING_ROOM_PUBLIC_ORIGIN, or a loopback HTTP origin while the API listens on a loopback host outside production.');
  }
  return {
    clientId,
    clientSecret,
    publicOrigin,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
  };
}
