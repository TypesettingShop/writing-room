import { InMemoryManuscriptRepository } from '../src/platform/manuscript/common/inMemoryManuscriptStore.js';
import { createApiServer } from './apiServer.js';
import { devAuthenticate } from './auth/devAuth.js';
import { readApiConfig } from './config.js';

async function main(): Promise<void> {
  const config = readApiConfig(process.env);
  if (config.store === 'postgres') {
    throw new Error('The postgres store is not available in this build.');
  }
  const repository = new InMemoryManuscriptRepository();
  const authenticate = config.auth === 'dev' ? devAuthenticate : () => undefined;
  const server = createApiServer({ ...config, repository, authenticate });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  if (address && typeof address !== 'string') {
    console.log('Writing Room API listening on ' + address.port);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
