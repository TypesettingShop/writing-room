import { readFileSync } from 'node:fs';
import { samplePackage } from './vsix.mjs';

const read = name => readFileSync(new URL('../extensions/runtime/globals/' + name, import.meta.url));
const files = Object.fromEntries([
  'extension.js', 'worker.js', 'data.json', 'package.nls.json', 'package.nls.ko.json', 'l10n/bundle.l10n.ko.json',
].map(name => [name, read(name)]));
const bytes = samplePackage({ manifest: JSON.parse(read('package.json')), files });
const worker = files['worker.js'];

export default {
  '/runtime/globals.vsix': (_request, response) => response.writeHead(200, {
    'Content-Type': 'application/zip', 'Content-Length': bytes.length,
  }).end(bytes),
  '/runtime/globals/worker.js': (_request, response) => response.writeHead(200, {
    'Content-Type': 'text/plain', 'Content-Length': worker.length,
  }).end(worker),
};
