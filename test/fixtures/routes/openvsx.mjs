// An Open VSX stand-in for the pinned real extensions, served from the git-ignored cache that
// scripts/fetch-real-extensions.mjs fills. It answers in the shape measured on open-vsx.org (2026-11-19):
//
//   /openvsx/api/-/search?query=&size=&offset=        { offset, totalSize, extensions: [...] }
//   /openvsx/api/{namespace}/{name}[/{version|latest}] version metadata with files.download, sha256, signature, publicKey
//   /openvsx/api/{namespace}/{name}/{version}/file/{file}
//                                                      302 to the second host, as open-vsx.org does to
//                                                      openvsx.eclipsecontent.org: http://localhost:<port>/openvsx-content/...
//   /openvsx/api/-/public-key/{id}                     the Ed25519 public key (PEM)
//
// The gallery's service URL is http://127.0.0.1:<port>/openvsx. Every response that carries bytes checks the whole
// cached set of that extension first (each file against pins.json, the .sha256 file and the signature); a file that
// does not match is never served. Paths are fixed from pins.json, so nothing outside the cache can be named.
// E2E_REAL_EXTENSIONS_CACHE overrides the cache folder (tests of the missing-cache rule).
import {
  defaultCacheDir, MissingCacheError, packageBaseName, readPins, readZip, verifyCachedPin,
} from '../../../scripts/lib/real-extensions.mjs';

const cacheDir = process.env.E2E_REAL_EXTENSIONS_CACHE || defaultCacheDir;
const pins = await readPins();
const api = '/openvsx/api';
const content = '/openvsx-content';

const types = { '.vsix': 'application/zip', '.sigzip': 'application/zip', '.sha256': 'text/plain', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.pem': 'application/x-pem-file' };
const typeOf = file => types[/\.[^.]+$/.exec(file)?.[0] ?? ''] ?? 'application/octet-stream';

function origin(request) {
  return 'http://' + (request.headers.host ?? '127.0.0.1');
}

function secondHost(request) {
  const port = /:(\d+)$/.exec(request.headers.host ?? '')?.[1];
  return 'http://localhost' + (port ? ':' + port : '');
}

function send(response, status, body, type = 'application/json') {
  response.writeHead(status, {
    'Content-Type': type,
    // Open VSX sends these on every API response; the gallery client reads them.
    'X-RateLimit-Limit': '10800',
    'X-RateLimit-Remaining': '10799',
  }).end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// The cached, verified files of one pin, or an error response. A missing cache is 404, a mismatch 500.
async function verified(pin, response) {
  try {
    return await verifyCachedPin(pins, pin, cacheDir);
  } catch (error) {
    const missing = error instanceof MissingCacheError;
    if (!missing) {
      console.error(`openvsx fixture: refusing ${pin.id}@${pin.version}: ${error.message}`);
    }
    send(response, missing ? 404 : 500, { error: error.message });
    return undefined;
  }
}

function manifestOf(vsix) {
  return JSON.parse(readZip(vsix).read('extension/package.json').toString('utf8'));
}

function extensionKind(manifest) {
  if (manifest.browser) {
    return ['workspace', 'web'];
  }
  return manifest.main ? ['workspace'] : ['ui', 'workspace', 'web'];
}

function fileUrls(request, pin, manifest) {
  const base = `${origin(request)}${api}/${pin.namespace}/${pin.name}/${pin.version}/file/`;
  const name = packageBaseName(pin);
  return {
    download: base + name + '.vsix',
    sha256: base + name + '.sha256',
    signature: base + name + '.sigzip',
    manifest: base + 'package.json',
    // Open VSX names the icon by its base name, e.g. markdownlint-128.png for images/markdownlint-128.png.
    ...manifest.icon ? { icon: base + manifest.icon.split('/').pop() } : {},
    publicKey: `${origin(request)}${api}/-/public-key/${pin.publicKey}`,
  };
}

function summary(request, pin, manifest) {
  return {
    url: `${origin(request)}${api}/${pin.namespace}/${pin.name}`,
    files: fileUrls(request, pin, manifest),
    name: pin.name,
    namespace: pin.namespace,
    version: pin.version,
    timestamp: '2026-11-19T00:00:00Z',
    displayName: manifest.displayName ?? pin.name,
    description: manifest.description ?? '',
    downloadCount: 0,
    verified: true,
    deprecated: false,
  };
}

function metadata(request, pin, manifest, vsixSize) {
  return {
    ...summary(request, pin, manifest),
    namespaceUrl: `${origin(request)}${api}/${pin.namespace}`,
    allVersions: { latest: `${origin(request)}${api}/${pin.namespace}/${pin.name}/latest`,
      [pin.version]: `${origin(request)}${api}/${pin.namespace}/${pin.name}/${pin.version}` },
    versionAlias: ['latest'],
    license: manifest.license ?? null,
    engines: manifest.engines ?? {},
    extensionKind: extensionKind(manifest),
    targetPlatform: 'universal',
    downloadable: true,
    downloadSizes: { universal: vsixSize },
    downloads: { universal: fileUrls(request, pin, manifest).download },
    dependencies: (manifest.extensionDependencies ?? []).map(id => ({ namespace: id.split('.')[0], extension: id.split('.')[1] })),
    bundledExtensions: [],
    preRelease: false,
    preview: false,
  };
}

const routes = {};

routes[`${api}/-/search`] = async (request, response) => {
  const query = new URL(request.url, 'http://fixture').searchParams;
  const text = (query.get('query') ?? '').toLowerCase();
  const size = Math.min(Math.max(Number(query.get('size') ?? 18) || 18, 1), 100);
  const offset = Math.max(Number(query.get('offset') ?? 0) || 0, 0);
  const matches = [];
  for (const pin of pins.extensions) {
    const files = await verifyCachedPin(pins, pin, cacheDir).catch(() => undefined);
    if (!files) {
      continue;
    }
    const manifest = manifestOf(files.vsix);
    const haystack = [pin.id, manifest.displayName, manifest.description, ...(manifest.keywords ?? [])].join(' ').toLowerCase();
    if (haystack.includes(text)) {
      matches.push(summary(request, pin, manifest));
    }
  }
  send(response, 200, { offset, totalSize: matches.length, extensions: matches.slice(offset, offset + size) });
};

for (const id of Object.keys(pins.publicKeys)) {
  routes[`${api}/-/public-key/${id}`] = async (_request, response) => {
    const pin = pins.extensions.find(candidate => candidate.publicKey === id);
    const files = pin && await verified(pin, response);
    if (files) {
      send(response, 200, files.publicKey, typeOf('.pem'));
    }
  };
}

for (const pin of pins.extensions) {
  const describe = async (request, response) => {
    const files = await verified(pin, response);
    if (files) {
      send(response, 200, metadata(request, pin, manifestOf(files.vsix), files.vsix.length));
    }
  };
  routes[`${api}/${pin.namespace}/${pin.name}`] = describe;
  routes[`${api}/${pin.namespace}/${pin.name}/latest`] = describe;
  routes[`${api}/${pin.namespace}/${pin.name}/${pin.version}`] = describe;

  // The files, by the names open-vsx.org uses. The manifest and the icon come out of the verified VSIX.
  const name = packageBaseName(pin);
  const files = {
    [name + '.vsix']: bytes => bytes.vsix,
    [name + '.sha256']: bytes => bytes.sha256File,
    [name + '.sigzip']: bytes => bytes.signature,
    'package.json': bytes => readZip(bytes.vsix).read('extension/package.json'),
  };
  // The icon's name is known only from the manifest; it can be listed when the cache is there at startup.
  const cached = await verifyCachedPin(pins, pin, cacheDir).catch(() => undefined);
  const icon = cached && manifestOf(cached.vsix).icon?.replace(/^\.\//, '');
  if (icon && /^[\w./-]+$/.test(icon) && !icon.split('/').includes('..')) {
    files[icon.split('/').pop()] = bytes => readZip(bytes.vsix).read('extension/' + icon);
  }
  for (const [file, pick] of Object.entries(files)) {
    const path = `${pin.namespace}/${pin.name}/${pin.version}/${file}`;
    routes[`${api}/${pin.namespace}/${pin.name}/${pin.version}/file/${file}`] = (request, response) => {
      response.writeHead(302, { Location: `${secondHost(request)}${content}/${path}` }).end();
    };
    routes[`${content}/${path}`] = async (_request, response) => {
      const bytes = await verified(pin, response);
      const body = bytes && pick(bytes);
      if (bytes && body) {
        send(response, 200, body, typeOf(file));
      } else if (bytes) {
        send(response, 404, { error: `${file} is not in the package` });
      }
    };
  }
}

export default routes;
