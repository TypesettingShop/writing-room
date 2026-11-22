import { spawn } from 'node:child_process';
import { build } from 'vite';

// Vite sets NODE_ENV for its own build. Preserve the caller’s environment for the API.
const serverEnv = { ...process.env };
let server;
let restarting = Promise.resolve();
const watcher = await build({ configFile: 'server/vite.config.ts', build: { watch: {} } });

function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    server.once('exit', resolve);
    server.kill();
  });
}

let closing = false;
watcher.on('event', event => {
  if (event.code === 'BUNDLE_END') {
    restarting = restarting.then(async () => {
      await stopServer();
      if (!closing) {
        server = spawn(process.execPath, ['dist-server/main.js'], { stdio: 'inherit', env: serverEnv });
      }
    });
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    closing = true;
    await watcher.close();
    await restarting;
    await stopServer();
  });
}
