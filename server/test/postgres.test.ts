// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contractOther, contractOwner, contractTime, manuscriptStoreContract,
} from '../../src/platform/manuscript/test/common/manuscriptStoreContract.js';
import { migrate } from '../store/migrate.js';
import { createPostgresPool, PostgresManuscriptRepository } from '../store/postgresManuscriptRepository.js';
import { startTestApi } from './apiFixture.js';
import { fetchContractStore } from './fetchContractStore.js';

const databaseUrl = process.env.WRITING_ROOM_TEST_DATABASE_URL;
if (!databaseUrl) {
  console.info('Skipping PostgreSQL tests: set WRITING_ROOM_TEST_DATABASE_URL after running npm run db:up.');
}

describe.skipIf(!databaseUrl)('PostgreSQL manuscript storage', () => {
  let admin: Pool;
  let pool: Pool;
  let repository: PostgresManuscriptRepository;
  // Identifiers cannot be bound in DDL. This one is built solely from a generated UUID.
  const schema = 'test_' + randomUUID().replaceAll('-', '');

  beforeAll(async () => {
    admin = createPostgresPool(databaseUrl!, 2);
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPostgresPool(databaseUrl!, 10, '-c search_path=' + schema);
    await Promise.all([migrate(pool), migrate(pool)]);
    repository = new PostgresManuscriptRepository(pool, () => contractTime);
    await Promise.all([repository.ensureDevUser(contractOwner), repository.ensureDevUser(contractOther)]);
  }, 25_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      try {
        await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      } finally {
        await admin.end();
      }
    }
  });

  manuscriptStoreContract('repository contract', async () => ({
    owner: repository.forUser(contractOwner),
    other: repository.forUser(contractOther),
  }));

  describe('HTTP contract against PostgreSQL', () => {
    let api: Awaited<ReturnType<typeof startTestApi>>;
    beforeAll(async () => { api = await startTestApi({ store: 'postgres', repository }); });
    afterAll(async () => api.close());
    manuscriptStoreContract('HTTP', async () => ({
      owner: fetchContractStore(api.fetch, 'owner'),
      other: fetchContractStore(api.fetch, 'other'),
    }));
  });

  it('serializes migrations, tracks checksums, and rolls back a failed migration', async () => {
    expect((await pool.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: '0001' }]);
    await expect(migrate(pool, [{ version: '0001', sql: 'SELECT 1' }])).rejects.toThrow('Checksum changed for migration 0001');
    await expect(migrate(pool, [{ version: '9999', sql: 'CREATE TABLE failed_migration(id int); SELECT 1/0;' }])).rejects.toThrow();
    expect((await pool.query("SELECT to_regclass('failed_migration') AS name")).rows).toEqual([{ name: null }]);
    expect((await pool.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: '0001' }]);
  });
});
