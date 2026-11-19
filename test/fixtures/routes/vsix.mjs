// VSIX packages for the install specs, built on request so that no binary package is committed.
import { crc32, deflateRawSync } from 'node:zlib';

const encoder = new TextEncoder();

/** Writes a ZIP archive: deflated entries, UTF-8 names, no extra fields. */
export function createZip(entries) {
  const locals = [];
  const records = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(typeof data === 'string' ? encoder.encode(data) : data);
    const compressed = deflateRawSync(raw);
    const checksum = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    records.push(record, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#3a3"/></svg>';

const code = `const vscode = require('vscode');
exports.activate = function (context) {
  const status = vscode.window.createStatusBarItem();
  status.text = 'VSIX fixture active';
  status.show();
  context.subscriptions.push(status, vscode.commands.registerCommand('fixture.vsix.hello', () =>
    vscode.window.showInformationMessage('VSIX extension ran.', 'OK')));
};
`;

export function sampleManifest(version = '1.0.0', overrides = {}) {
  return {
    name: 'vsix-sample', publisher: 'writing-room-tests', displayName: '%displayName%', version,
    engines: { vscode: '^1.80.0' }, browser: './dist/extension.js', activationEvents: [],
    contributes: {
      commands: [{ command: 'fixture.vsix.hello', title: 'Run VSIX Fixture', icon: './media/icon.svg' }],
      menus: { 'editor/title': [{ command: 'fixture.vsix.hello', group: 'navigation' }] },
      viewsContainers: { activitybar: [{ id: 'vsix-fixture', title: 'VSIX Fixture', icon: './media/icon.svg' }] },
      views: { 'vsix-fixture': [{ id: 'fixture.vsix.view', name: 'VSIX Fixture View' }] },
    },
    ...overrides,
  };
}

function vsixManifest(platform) {
  const target = platform ? ` TargetPlatform="${platform}"` : '';
  return '<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">'
    + `<Metadata><Identity Language="en-US" Id="vsix-sample" Version="1.0.0" Publisher="writing-room-tests"${target}/></Metadata></PackageManifest>`;
}

export function samplePackage({ version = '1.0.0', manifest = sampleManifest(version), platform, files } = {}) {
  const entries = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="utf-8"?><Types/>' },
    { name: 'extension.vsixmanifest', data: vsixManifest(platform) },
  ];
  if (manifest) {
    entries.push({ name: 'extension/package.json', data: JSON.stringify(manifest, undefined, 2) });
  }
  for (const [name, data] of Object.entries(files ?? {
    'dist/extension.js': code,
    'media/icon.svg': icon,
    'package.nls.json': JSON.stringify({ displayName: 'VSIX Fixture' }),
  })) {
    entries.push({ name: 'extension/' + name, data });
  }
  return createZip(entries);
}

const packages = {
  'sample.vsix': () => samplePackage(),
  'sample-1.1.0.vsix': () => samplePackage({ version: '1.1.0' }),
  'broken.vsix': () => Buffer.from('this is not a zip archive'),
  'no-manifest.vsix': () => samplePackage({ manifest: null }),
  'engine.vsix': () => samplePackage({ manifest: sampleManifest('1.0.0', { engines: { vscode: '^2.0.0' } }) }),
  'platform.vsix': () => samplePackage({ platform: 'linux-x64' }),
  'node-only.vsix': () => samplePackage({ manifest: sampleManifest('1.0.0', { browser: undefined, main: './dist/extension.js' }) }),
};

function send(bytes) {
  return (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes.length }).end(bytes);
  };
}

const routes = Object.fromEntries(Object.entries(packages).map(([name, create]) => {
  let bytes;
  return ['/vsix/' + name, (request, response) => send(bytes ??= create())(request, response)];
}));

export default {
  ...routes,
  '/vsix/redirect.vsix': (_request, response) => {
    response.writeHead(302, { Location: '/vsix/sample.vsix' }).end();
  },
  // A package larger than 50 MiB that does not announce its length.
  '/vsix/oversize.vsix': (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/zip' });
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    const write = () => {
      while (sent < 51 && !response.destroyed) {
        sent++;
        if (!response.write(chunk)) {
          response.once('drain', write);
          return;
        }
      }
      response.end();
    };
    write();
  },
};
