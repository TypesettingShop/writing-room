import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Connect, Plugin, ViteDevServer } from 'vite';

const webviewAssets = new Map([
  ['/webview/index.html', 'text/html; charset=utf-8'],
  ['/webview/service-worker.js', 'text/javascript; charset=utf-8'],
]);

function webviewShell(): Plugin {
  const rawPort = process.env.WRITING_ROOM_WEBVIEW_PORT;
  const loopback = '127.0.0.1';
  const configPath = '/webview/config.json';

  function readAsset(path: string): Buffer {
    return readFileSync(new URL('./src/workbench/contrib/webview/browser/pre/' + path.split('/').at(-1), import.meta.url));
  }

  const assets = (read: (path: string) => Buffer): Connect.NextHandleFunction => (request, response, next) => {
    const path = request.url?.split('?', 1)[0] ?? '';
    const type = webviewAssets.get(path);
    if (!type) {
      if (path.startsWith('/webview/')) {
        response.writeHead(404).end();
      } else {
        next();
      }
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let body: Buffer | undefined;
    try {
      body = request.method === 'GET' ? read(path) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        response.writeHead(404).end();
        return;
      }
      throw error;
    }
    response.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }).end(body);
  };

  async function configure(
    app: ViteDevServer['httpServer'], middleware: Connect.Server, requestedPort: number,
    strictPort: boolean | undefined, serve: Connect.NextHandleFunction,
  ): Promise<void> {
    if (rawPort !== undefined) {
      const port = Number(rawPort);
      if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('WRITING_ROOM_WEBVIEW_PORT must be a TCP port between 1 and 65535.');
      }
      if (!app || port === requestedPort) {
        throw new Error('WRITING_ROOM_WEBVIEW_PORT requires a listener on a port distinct from the app port.');
      }
      const secondary = createServer((request, response) =>
        serve(request, response, () => response.writeHead(404).end()));
      await new Promise<void>((resolve, reject) => {
        secondary.once('error', error => reject(new Error(
          'WRITING_ROOM_WEBVIEW_PORT could not listen on ' + loopback + ':' + port + '. ' + error.message, { cause: error },
        )));
        secondary.listen(port, loopback, resolve);
      });
      secondary.unref();
      app.once('close', () => secondary.close());
      app.on('error', (error: NodeJS.ErrnoException) => {
        if (strictPort || error.code !== 'EADDRINUSE') {
          secondary.close();
        }
      });
      middleware.use((request, response, next) => {
        if (request.url?.split('?', 1)[0] !== configPath) {
          next();
          return;
        }
        const address = app.address();
        if (!address || typeof address === 'string') {
          response.writeHead(503).end();
          return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { Allow: 'GET, HEAD' }).end();
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        }).end(request.method === 'GET' ? JSON.stringify({ appPort: address.port, webviewPort: port }) : undefined);
      });
    }
    middleware.use(serve);
  }

  return {
    name: 'webview-shell',
    configureServer({ httpServer, middlewares, config }) {
      return configure(httpServer, middlewares, config.server.port ?? 5173,
        config.server.strictPort, assets(readAsset));
    },
    configurePreviewServer({ httpServer, middlewares, config }) {
      return configure(httpServer, middlewares, config.preview.port ?? 4173,
        config.preview.strictPort, assets(path => readFileSync(resolve(config.root, config.build.outDir, path.slice(1)))));
    },
    generateBundle() {
      for (const path of webviewAssets.keys()) {
        this.emitFile({ type: 'asset', fileName: path.slice(1), source: readAsset(path) });
      }
    },
  };
}

const require = createRequire(import.meta.url);
const codiconModule = 'virtual:codicon-names';
const resolvedCodiconModule = '\0' + codiconModule;

export default defineConfig({
  appType: 'mpa',
  // The extension Worker initializes forwarding before it exposes the synchronous Webview API.
  worker: { format: 'es' },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  plugins: [
    webviewShell(),
    {
      name: 'codicon-names',
      resolveId(id) {
        return id === codiconModule ? resolvedCodiconModule : undefined;
      },
      load(id) {
        if (id !== resolvedCodiconModule) {
          return;
        }
        // The CSS includes aliases for glyphs that the font's CSV lists only once.
        const css = readFileSync(require.resolve('@vscode/codicons/dist/codicon.css'), 'utf8');
        const names = Array.from(
          css.matchAll(/\.codicon-([a-z0-9-]+)::?before\s*\{\s*content:/gi),
          match => match[1],
        );
        if (names.length === 0) {
          throw new Error('Could not read icon names from the Codicons stylesheet.');
        }
        return 'export default ' + JSON.stringify(names);
      },
    },
    {
      name: 'third-party-notices',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'ThirdPartyNotices.txt',
          source: readFileSync(new URL('./ThirdPartyNotices.txt', import.meta.url)),
        });
      },
    },
  ],
});
