import type { Pool } from 'pg';
import type { CharactersRepository } from '../src/platform/characters/common/charactersStore.js';
import { InMemoryCharactersRepository } from '../src/platform/characters/common/inMemoryCharactersStore.js';
import { InMemoryManuscriptRepository } from '../src/platform/manuscript/common/inMemoryManuscriptStore.js';
import type { ManuscriptRepository } from '../src/platform/manuscript/common/manuscriptStore.js';
import { InMemoryWorldRepository } from '../src/platform/world/common/inMemoryWorldStore.js';
import type { WorldRepository } from '../src/platform/world/common/worldStore.js';
import { createApiServer } from './apiServer.js';
import { MemoryAuthStore } from './auth/authStore.js';
import { devAuthenticate, devUserId } from './auth/devAuth.js';
import { PostgresAuthStore } from './auth/postgresAuthStore.js';
import { readApiConfig } from './config.js';
import { migrate } from './store/migrate.js';
import { PostgresCharactersRepository } from './store/postgresCharactersRepository.js';
import { createPostgresPool, PostgresManuscriptRepository } from './store/postgresManuscriptRepository.js';

async function main(): Promise<void> {
  const config = readApiConfig(process.env);
  const authenticate = config.auth === 'dev' ? devAuthenticate : undefined;
  let pool: Pool | undefined;
  try {
    let repository: ManuscriptRepository;
    let charactersRepository: CharactersRepository;
    let worldRepository: WorldRepository | undefined;
    if (config.store === 'postgres' && config.databaseUrl) {
      pool = createPostgresPool(config.databaseUrl, config.databasePoolSize);
      pool.on('error', () => console.error('Unexpected failure on an idle PostgreSQL connection.'));
      await migrate(pool);
      const postgres = new PostgresManuscriptRepository(pool);
      if (config.auth === 'dev') {
        await postgres.ensureDevUser(devUserId);
      }
      repository = postgres;
      charactersRepository = new PostgresCharactersRepository(pool);
    } else if (config.store === 'memory') {
      const memory = new InMemoryManuscriptRepository();
      repository = memory;
      charactersRepository = new InMemoryCharactersRepository(userId => memory.workAccess(userId));
      worldRepository = new InMemoryWorldRepository(userId => memory.workAccess(userId));
    } else {
      throw new Error('The postgres store requires WRITING_ROOM_DATABASE_URL.');
    }
    const authStore = pool ? new PostgresAuthStore(pool) : new MemoryAuthStore();
    await authStore.deleteExpiredSessions(new Date());
    const server = createApiServer({
      ...config,
      repository,
      charactersRepository,
      worldRepository,
      authenticate,
      accountAuth: { ...config, store: authStore },
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
    // Logins prune only their own user's expired sessions; sweep the rest while the server runs.
    const sessionSweep = setInterval(() => {
      authStore.deleteExpiredSessions(new Date()).catch(() => console.error('Could not delete expired sessions.'));
    }, 60 * 60 * 1000);
    sessionSweep.unref();
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
          clearInterval(sessionSweep);
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
