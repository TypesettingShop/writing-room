import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import type { Connect, Plugin } from 'vite';

const webviewAssets = new Map([
  ['/webview/index.html', 'text/html; charset=utf-8'],
  ['/webview/service-worker.js', 'text/javascript; charset=utf-8'],
]);

function webviewShell(): Plugin {
  function readAsset(path: string): Buffer {
    return readFileSync(new URL('./src/workbench/contrib/webview/browser/pre/' + path.split('/').at(-1), import.meta.url));
  }

  const serve: Connect.NextHandleFunction = (request, response, next) => {
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
    response.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }).end(request.method === 'GET' ? readAsset(path) : undefined);
  };

  return {
    name: 'webview-shell',
    configureServer(server) {
      server.middlewares.use(serve);
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
