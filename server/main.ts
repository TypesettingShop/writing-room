import type { Pool } from 'pg';
import { InMemoryManuscriptRepository } from '../src/platform/manuscript/common/inMemoryManuscriptStore.js';
import type { ManuscriptRepository } from '../src/platform/manuscript/common/manuscriptStore.js';
import { createApiServer } from './apiServer.js';
import { devAuthenticate, devUserId } from './auth/devAuth.js';
import { readApiConfig } from './config.js';
import { migrate } from './store/migrate.js';
import { createPostgresPool, PostgresManuscriptRepository } from './store/postgresManuscriptRepository.js';

async function main(): Promise<void> {
  const config = readApiConfig(process.env);
  const authenticate = config.auth === 'dev' ? devAuthenticate : () => undefined;
  let pool: Pool | undefined;
  try {
    let repository: ManuscriptRepository;
    if (config.store === 'postgres' && config.databaseUrl) {
      pool = createPostgresPool(config.databaseUrl, config.databasePoolSize);
      pool.on('error', () => console.error('Unexpected failure on an idle PostgreSQL connection.'));
      await migrate(pool);
      const postgres = new PostgresManuscriptRepository(pool);
      if (config.auth === 'dev') {
        await postgres.ensureDevUser(devUserId);
      }
      repository = postgres;
    } else if (config.store === 'memory') {
      repository = new InMemoryManuscriptRepository();
    } else {
      throw new Error('The postgres store requires WRITING_ROOM_DATABASE_URL.');
    }
    const server = createApiServer({ ...config, repository, authenticate });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
    const address = server.address();
    if (address && typeof address !== 'string') {
      console.log('Writing Room API listening on ' + address.port);
    }
    if (pool) {
      const connectionPool = pool;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
          server.close(() => { void connectionPool.end(); });
        });
      }
    }
  } catch (error) {
    await pool?.end();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Could not start the API server.');
  process.exitCode = 1;
});
