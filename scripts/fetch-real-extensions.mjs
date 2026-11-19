#!/usr/bin/env node
// Downloads the pinned real extensions (VSIX, .sha256, .sigzip and the Open VSX public key) into the git-ignored
// cache and checks every file against test/fixtures/real-extensions/pins.json. A cached file that already matches is
// kept; one that does not match makes the script fail instead of being used or silently replaced.
//
//   node scripts/fetch-real-extensions.mjs [--offline] [--pins <file>] [--cache <dir>] [<extension id>...]
//
// --offline checks the cache without any network request.
import { parseArgs } from 'node:util';
import {
  cachedFiles, defaultCacheDir, defaultPinsPath, download, IntegrityError, readPins, readVerified, selectPins,
  verifyPackageSignature, writeVerified,
} from './lib/real-extensions.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    offline: { type: 'boolean', default: false },
    pins: { type: 'string', default: defaultPinsPath },
    cache: { type: 'string', default: defaultCacheDir },
  },
});

const pins = await readPins(values.pins);
const failures = [];

async function ensure(file, label) {
  const cached = await readVerified(file);
  if (cached) {
    return { bytes: cached, fetched: false };
  }
  if (values.offline) {
    throw new Error(`${label}: ${file.path} is not in the cache (run without --offline to download it)`);
  }
  const bytes = await download(file.url, file.limit);
  await writeVerified(file, bytes);
  // Read back what landed on disk, so the checks below look at the cached bytes.
  return { bytes: await readVerified(file), fetched: true };
}

for (const pin of selectPins(pins, positionals)) {
  const label = `${pin.id}@${pin.version}`;
  const files = cachedFiles(pins, pin, values.cache);
  try {
    const vsix = await ensure(files.vsix, label);
    const sha256File = await ensure(files.sha256File, label);
    const signature = await ensure(files.signature, label);
    const publicKey = await ensure(files.publicKey, label);
    const published = new TextDecoder().decode(sha256File.bytes).trim().toLowerCase();
    if (published !== pin.vsix.sha256) {
      throw new IntegrityError(`${files.sha256File.path}: says ${published}, the pin says ${pin.vsix.sha256}`);
    }
    if (!verifyPackageSignature(vsix.bytes, signature.bytes, publicKey.bytes)) {
      throw new IntegrityError(`${files.vsix.path}: the Ed25519 signature in ${files.signature.path} does not verify`);
    }
    const fetched = [vsix, sha256File, signature, publicKey].some(file => file.fetched);
    process.stdout.write(`ok ${label} ${fetched ? 'downloaded' : 'cached'} (sha256 and signature verified)\n`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

if (failures.length) {
  process.stderr.write(failures.map(failure => `FAILED ${failure}\n`).join(''));
  process.stderr.write('A cached file that does not match its pin is untrusted. Delete it and run this script again.\n');
  process.exitCode = 1;
}
