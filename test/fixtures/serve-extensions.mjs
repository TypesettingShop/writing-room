import { createServer } from 'node:http';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2]);
const extensionsRoot = realpathSync(fileURLToPath(new URL('./extensions/', import.meta.url)));
const routesRoot = new URL('./routes/', import.meta.url);
const fixture = file => readFileSync(new URL('./extensions/remote/' + file, import.meta.url));
const manifest = fixture('package.json');
const code = fixture('extension.js');
const icon = fixture('icon.png');

const contentTypes = new Map([
  ['.json', 'application/json'], ['.js', 'text/javascript'], ['.mjs', 'text/javascript'],
  ['.css', 'text/css'], ['.html', 'text/html'], ['.txt', 'text/plain'], ['.md', 'text/plain'],
  ['.wasm', 'application/wasm'], ['.vsix', 'application/zip'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.jpg', 'image/jpeg'], ['.webp', 'image/webp'],
]);

const routes = new Map();
let routeFiles = [];
try {
  routeFiles = readdirSync(routesRoot, { withFileTypes: true })
    .filter(file => file.isFile() && file.name.endsWith('.mjs'))
    .map(file => file.name).sort();
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}
for (const file of routeFiles) {
  const { default: handlers } = await import(new URL(file, routesRoot));
  for (const [path, handler] of Object.entries(handlers)) {
    if (normalizeTarget(path)?.join('/') !== path.slice(1) || typeof handler !== 'function' || routes.has(path)) {
      throw new Error('Invalid or duplicate extension fixture route ' + path + ' in ' + file);
    }
    routes.set(path, handler);
  }
}

function normalizeTarget(target = '') {
  // Read the origin-form target before URL parsing can collapse dot segments.
  const [path] = target.split('?', 1);
  if (!path.startsWith('/') || path.startsWith('//')) {
    return undefined;
  }
  try {
    const segments = path.slice(1).split('/').map(decodeURIComponent);
    return segments.every(segment => segment && segment !== '.' && segment !== '..'
      && !/[\\/%?#\u0000-\u001f\u007f]/.test(segment)) ? segments : undefined;
  } catch {
    return undefined;
  }
}

function isDescendant(folder, path) {
  const child = relative(folder, path);
  return child !== '' && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
}

async function serveFixture(segments, response) {
  const [name, ...relativePath] = segments;
  if (relativePath.length === 0) {
    response.writeHead(404).end();
    return;
  }
  try {
    const folder = await realpath(resolve(extensionsRoot, name));
    const path = await realpath(resolve(folder, ...relativePath));
    if (isDescendant(extensionsRoot, folder) && isDescendant(folder, path) && (await stat(path)).isFile()) {
      const bytes = await readFile(path);
      const contentType = contentTypes.get(extname(path)) ?? 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': contentType }).end(bytes);
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      throw error;
    }
  }
  response.writeHead(404).end();
}

async function serve(request, response) {
  const segments = normalizeTarget(request.url);
  if (!segments) {
    response.writeHead(404).end();
    return;
  }
  const pathname = '/' + segments.join('/');
  if (pathname !== '/no-cors/package.json') {
    response.setHeader('Access-Control-Allow-Origin', '*');
  }
  response.setHeader('Cache-Control', 'no-store');
  if (pathname === '/redirect/package.json') {
    response.writeHead(302, { Location: '/remote/package.json' }).end();
  } else if (pathname === '/oversize/package.json') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write(' '.repeat(256 * 1024));
    response.end(manifest);
  } else if (pathname === '/oversize-entry/package.json') {
    const larger = { ...JSON.parse(manifest), name: 'oversize-entry' };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(larger));
  } else if (pathname === '/oversize-entry/extension.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.write(' '.repeat(5 * 1024 * 1024));
    response.end(code);
  } else if (['/no-cors/package.json', '/oversize-icon/package.json'].includes(pathname)) {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(manifest);
  } else if (pathname === '/oversize-icon/extension.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
  } else if (pathname === '/oversize-icon/icon.png') {
    response.writeHead(200, { 'Content-Type': 'image/png' });
    response.write(Buffer.alloc(256 * 1024));
    response.end(icon);
  } else if (pathname === '/oversize-entry/icon.png') {
    response.writeHead(200, { 'Content-Type': 'image/png' }).end(icon);
  } else {
    const route = routes.get(pathname);
    if (route) {
      await route(request, response);
    } else {
      await serveFixture(segments, response);
    }
  }
}

const server = createServer((request, response) => {
  void serve(request, response).catch(error => {
    console.error('Extension fixture request failed:', error);
    if (response.headersSent) {
      response.destroy();
    } else {
      response.writeHead(500).end();
    }
  });
});
server.listen(port, '127.0.0.1', () => process.stdout.write('Extension fixtures listening on ' + server.address().port + '\n'));
