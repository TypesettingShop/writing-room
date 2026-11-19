import type { ServerOptions } from 'node:https';

export function openForwardingProxy(appPort: number, webviewPort: number, tls: ServerOptions): Promise<{
  port: number;
  close(): Promise<void>;
}>;
