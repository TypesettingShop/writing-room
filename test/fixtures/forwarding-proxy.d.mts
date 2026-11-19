import type { ServerOptions } from 'node:https';

export function openForwardingProxy(appPort: number, webviewPort: number, tls: ServerOptions, fixturesPort?: number): Promise<{
  port: number;
  close(): Promise<void>;
}>;
