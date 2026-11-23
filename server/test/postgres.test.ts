// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { manuscriptLimits } from '../../src/platform/manuscript/common/manuscript.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contractOther, contractOwner, contractTime, manuscriptStoreContract,
} from '../../src/platform/manuscript/test/common/manuscriptStoreContract.js';
import { migrate } from '../store/migrate.js';
import { createPostgresPool, PostgresManuscriptRepository } from '../store/postgresManuscriptRepository.js';
import { startTestApi } from './apiFixture.js';
import { httpContractStore } from './httpContractStore.js';

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

  async function seedFullWork(workId: string): Promise<number> {
    // Fill the work directly so this test exercises the limit without 10,000 locked SQL transactions.
    await pool.query(`
      INSERT INTO nodes (work_id, kind, position)
      SELECT $1, 'part', value FROM generate_series(0, $2::integer - 1) AS value
    `, [workId, manuscriptLimits.nodes]);
    return 0;
  }

  manuscriptStoreContract('repository contract', async () => ({
    owner: repository.forUser(contractOwner),
    other: repository.forUser(contractOther),
    seedFullWork,
  }));

  describe('HTTP contract against PostgreSQL', () => {
    let api: Awaited<ReturnType<typeof startTestApi>>;
    beforeAll(async () => { api = await startTestApi({ store: 'postgres', repository }); });
    afterAll(async () => api.close());
    manuscriptStoreContract('HTTP', async () => ({
      owner: httpContractStore(api.fetch, 'owner'),
      other: httpContractStore(api.fetch, 'other'),
      seedFullWork,
    }));
  });

  it('rejects metadata growth beyond the work budget and still serves the tree', async () => {
    const owner = repository.forUser(contractOwner);
    const work = await owner.createWork({ title: 'Work with metadata' });
    const { node } = await owner.createNode(work.id, { kind: 'document', parentId: null, title: '' }, 0);
    const metadata = { text: 'a'.repeat(manuscriptLimits.metadata - '{"text":""}'.length) };
    await pool.query(`
      INSERT INTO nodes (work_id, kind, position, metadata)
      SELECT $1, 'part', position, $3 FROM generate_series(1, $2::integer) AS position
    `, [work.id, manuscriptLimits.workMetadata / manuscriptLimits.metadata, metadata]);
    const api = await startTestApi({ store: 'postgres', repository });
    try {
      const browser = httpContractStore(api.fetch, 'owner');
      await expect(browser.updateNode(work.id, node.id, { metadata: { key: 'value' } }, 1))
        .rejects.toMatchObject({ code: 'too_large' });
      const tree = await browser.getTree(work.id);
      expect(tree.revision).toBe(1);
      expect(tree.nodes[0].metadata).toEqual({});
      expect(tree.nodes.at(-1)?.metadata).toEqual(metadata);
    } finally {
      await api.close();
    }
  }, 30_000);

  it('serializes migrations, tracks checksums, and rolls back a failed migration', async () => {
    const applied = (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows;
    expect(applied).toContainEqual({ version: '0001' });
    await expect(migrate(pool, [{ version: '0001', sql: 'SELECT 1' }])).rejects.toThrow('Checksum changed for migration 0001');
    await expect(migrate(pool, [{ version: '9999', sql: 'CREATE TABLE failed_migration(id int); SELECT 1/0;' }])).rejects.toThrow();
    expect((await pool.query("SELECT to_regclass('failed_migration') AS name")).rows).toEqual([{ name: null }]);
    expect((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows).toEqual(applied);
  });
});
