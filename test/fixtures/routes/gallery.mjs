// Synthetic gallery failures and signed packages. The real packages are served by openvsx.mjs.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createZip, sampleManifest, samplePackage } from './vsix.mjs';

const routes = {};
const registry = 'https://open-vsx.org';
const cdn = 'https://openvsx.eclipsecontent.org';
const publisher = 'writing-room-tests';
const keys = generateKeyPairSync('ed25519');
const publicKey = '/api/-/public-key/gallery-test';
const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#489"/></svg>';
const scenarios = [
  'signed', 'unsigned', 'bad-hash', 'bad-signature', 'bad-host', 'slow',
  'node-metadata', 'node-package', 'dependency', 'with-dependency', 'pack', 'declarative',
];
const results = [];

function send(response, body, type = 'application/json') {
  response.writeHead(200, { 'Content-Type': type }).end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function set(path, handler) {
  routes['/gallery' + path] = handler;
}

set(publicKey, (_request, response) => send(response, keys.publicKey.export({ type: 'spki', format: 'pem' }), 'text/plain'));

for (const scenario of scenarios) {
  const name = 'gallery-' + scenario;
  const id = publisher + '.' + name;
  const titles = scenario === 'signed' ? ['1.0.0', '1.1.0'] : ['1.0.0'];
  for (const version of titles) {
    const path = `/api/${publisher}/${name}/${version}`;
    const asset = type => path + '/file/' + type;
    const files = {
      download: registry + asset('package.vsix'), sha256: registry + asset('package.sha256'),
      ...scenario === 'unsigned' ? {} : { signature: registry + asset('package.sigzip'), publicKey: registry + publicKey },
      icon: registry + asset('icon.svg'),
    };
    const summary = {
      namespace: publisher, name, version, displayName: 'Gallery ' + scenario,
      description: scenario === 'signed' ? '<span data-gallery-fixture>Fixture text</span>' : 'Gallery fixture',
      downloadCount: 17, verified: true, files,
    };
    if (version === titles.at(-1)) {
      results.push(summary);
      set(`/api/${publisher}/${name}`, (_request, response) => send(response, metadata));
    }
    const dependency = scenario === 'with-dependency' ? [publisher + '.gallery-dependency'] : [];
    const metadata = {
      ...summary, license: 'MIT',
      extensionKind: scenario === 'node-metadata' ? ['workspace'] : ['web'],
      dependencies: dependency.map(value => ({ namespace: publisher, extension: value.split('.')[1] })),
      bundledExtensions: scenario === 'pack' ? [{ namespace: publisher, extension: 'gallery-dependency' }] : [],
    };
    const command = 'fixture.' + name + '.hello';
    const manifest = sampleManifest(version, {
      name, displayName: 'Gallery ' + scenario, license: 'MIT', extensionDependencies: dependency,
      ...(scenario === 'node-package' ? { browser: undefined, main: './dist/extension.js' } : {}),
      ...(scenario === 'declarative' ? { browser: undefined } : {}),
      contributes: { commands: [{ command, title: 'Run Gallery ' + scenario }] },
    });
    const bytes = samplePackage({ manifest, files: {
      'dist/extension.js': `const vscode = require('vscode');
exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand(${JSON.stringify(command)},
  () => vscode.window.showInformationMessage(${JSON.stringify('Ran ' + id)}, 'OK')));`,
    } });
    const expected = createHash('sha256').update(bytes).digest('hex');
    const payload = Buffer.from(bytes);
    if (scenario === 'bad-hash') {
      payload[payload.length - 1] ^= 1;
    }
    const signature = sign(null, bytes, keys.privateKey);
    if (scenario === 'bad-signature') {
      signature[0] ^= 1;
    }
    const bundle = createZip([{ name: '.signature.sig', data: signature }]);
    set(path, (_request, response) => send(response, metadata));
    for (const [file, body, type] of [
      ['package.sha256', expected, 'text/plain'],
      ['package.sigzip', bundle, 'application/zip'],
      ['icon.svg', scenario === 'signed' ? ' '.repeat(256 * 1024 + 1) : icon, 'image/svg+xml'],
    ]) {
      set(asset(file), (_request, response) => send(response, body, type));
    }
    const content = path.replace('/api/', '/content/') + '/package.vsix';
    set(asset('package.vsix'), (_request, response) => {
      response.writeHead(302, { Location: (scenario === 'bad-host' ? 'https://wrong.example' : cdn) + content }).end();
    });
    set(content, (_request, response) => {
      if (scenario === 'slow') {
        const interval = setInterval(() => response.write(bytes.subarray(0, 4)), 150);
        response.on('close', () => clearInterval(interval));
        response.writeHead(200).flushHeaders();
      } else {
        send(response, payload, 'application/zip');
      }
    });
  }
}

set('/api/-/search', (request, response) => {
  const params = new URL(request.url, 'http://fixture').searchParams;
  const query = (params.get('query') ?? '').toLowerCase();
  const offset = Number(params.get('offset') ?? 0);
  const size = Number(params.get('size') ?? 20);
  if (query === 'rate-limited') {
    response.setHeader('Access-Control-Expose-Headers', 'X-RateLimit-Remaining');
    response.setHeader('X-RateLimit-Remaining', '0');
  }
  if (query === 'unavailable') {
    response.writeHead(503).end();
    return;
  }
  const matches = results.filter(result => result.name.includes(query));
  send(response, { offset, totalSize: matches.length, extensions: matches.slice(offset, offset + size) });
});

export default routes;
