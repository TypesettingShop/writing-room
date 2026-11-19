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
  cachedFiles, defaultCacheDir, defaultPinsPath, download, readPins, readVerified, selectPins, verifyCachedPin,
  writeVerified,
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

// Keeps a cached file that matches its pin, downloads a missing one, and throws on one that does not match.
async function ensure(file, label) {
  if (await readVerified(file)) {
    return false;
  }
  if (values.offline) {
    throw new Error(`${label}: ${file.path} is not in the cache (run without --offline to download it)`);
  }
  await writeVerified(file, await download(file.url, file.limit));
  return true;
}

for (const pin of selectPins(pins, positionals)) {
  const label = `${pin.id}@${pin.version}`;
  const files = cachedFiles(pins, pin, values.cache);
  try {
    let fetched = false;
    for (const file of Object.values(files)) {
      fetched = await ensure(file, label) || fetched;
    }
    // Checks what landed on disk: every file against its pin, the published .sha256 and the signature.
    await verifyCachedPin(pins, pin, values.cache);
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
