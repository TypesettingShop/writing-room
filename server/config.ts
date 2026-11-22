export const defaultApiPort = 8787;

export interface ApiConfig {
  host: string;
  port: number;
  store: 'memory' | 'postgres';
  auth?: 'dev';
  databaseUrl?: string;
  allowedOrigins: readonly string[];
}

export function readApiPort(env: NodeJS.ProcessEnv): number {
  const rawPort = env.WRITING_ROOM_API_PORT ?? String(defaultApiPort);
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65535) {
    throw new Error('WRITING_ROOM_API_PORT must be a TCP port from 0 to 65535.');
  }
  return port;
}

/** The address Vite's `/api` proxy reaches the API at, from the same variables the API listens on. */
export function readApiProxyTarget(env: NodeJS.ProcessEnv): string {
  const port = readApiPort(env);
  if (port === 0) {
    throw new Error('The /api proxy requires a fixed WRITING_ROOM_API_PORT, not 0.');
  }
  const host = env.WRITING_ROOM_API_HOST;
  // A wildcard listener also accepts loopback connections.
  const target = !host || host === 'localhost' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return 'http://' + (target.includes(':') ? '[' + target + ']' : target) + ':' + port;
}

export function readApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const host = env.WRITING_ROOM_API_HOST === 'localhost' ? '127.0.0.1' : env.WRITING_ROOM_API_HOST ?? '127.0.0.1';
  const port = readApiPort(env);
  const databaseUrl = env.WRITING_ROOM_DATABASE_URL;
  const store = env.WRITING_ROOM_STORE ?? (databaseUrl ? 'postgres' : undefined);
  if (store !== 'memory' && store !== 'postgres') {
    throw new Error('Set WRITING_ROOM_DATABASE_URL or select WRITING_ROOM_STORE explicitly.');
  }
  if (store === 'postgres' && !databaseUrl) {
    throw new Error('The postgres store requires WRITING_ROOM_DATABASE_URL.');
  }
  const auth = env.WRITING_ROOM_AUTH;
  if (auth !== undefined && auth !== 'dev') {
    throw new Error('WRITING_ROOM_AUTH must be dev or unset.');
  }
  if (auth === 'dev' && (env.NODE_ENV === 'production' || !['127.0.0.1', '::1'].includes(host))) {
    throw new Error('Development authentication requires a loopback host and a non-production environment.');
  }

  const allowedOrigins = env.WRITING_ROOM_PUBLIC_ORIGIN?.split(',').map(origin => origin.trim())
    ?? (env.NODE_ENV === 'production' ? [] : ['http://127.0.0.1:5173', 'http://localhost:5173']);
  if (allowedOrigins.some(origin => {
    const url = URL.parse(origin);
    return !url || url.origin !== origin || !['http:', 'https:'].includes(url.protocol);
  })) {
    throw new Error('WRITING_ROOM_PUBLIC_ORIGIN must contain HTTP origins without paths.');
  }
  return { host, port, store, auth, databaseUrl, allowedOrigins };
}
