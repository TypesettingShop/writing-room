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
      // SIGINT and SIGTERM can both arrive (a terminal and a watcher); the pool ends once.
      let stopping = false;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
          if (stopping) {
            return;
          }
          stopping = true;
          server.close(() => {
            connectionPool.end().catch(() => console.error('Could not close the PostgreSQL pool.'));
          });
        });
      }
    }
  } catch (error) {
    await pool?.end();
    throw error;
  }
}

// A connection refused on every address of a host name is an AggregateError without a message.
function startupFailure(error: unknown): string {
  if (error instanceof AggregateError && !error.message) {
    return error.errors.map(startupFailure).filter(Boolean).join('; ');
  }
  return error instanceof Error ? error.message : '';
}

main().catch((error: unknown) => {
  console.error(startupFailure(error) || 'Could not start the API server.');
  process.exitCode = 1;
});
