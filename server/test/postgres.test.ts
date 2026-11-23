// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { characterLimits } from '../../src/platform/characters/common/characters.js';
import { charactersStoreContract, maxCharacterValue } from '../../src/platform/characters/test/common/charactersStoreContract.js';
import { manuscriptLimits } from '../../src/platform/manuscript/common/manuscript.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contractOther, contractOwner, contractTime, manuscriptStoreContract,
} from '../../src/platform/manuscript/test/common/manuscriptStoreContract.js';
import { migrate } from '../store/migrate.js';
import { PostgresCharactersRepository } from '../store/postgresCharactersRepository.js';
import { createPostgresPool, PostgresManuscriptRepository } from '../store/postgresManuscriptRepository.js';
import { startTestApi } from './apiFixture.js';
import { httpCharactersStore } from './httpCharactersStore.js';
import migration0001 from '../store/migrations/0001_manuscript.sql?raw';
import migration0002 from '../store/migrations/0002_auth.sql?raw';
import migration0003 from '../store/migrations/0003_oauth.sql?raw';
import migration0004 from '../store/migrations/0004_auth_user_updated_at.sql?raw';
import { httpContractStore } from './httpContractStore.js';

const databaseUrl = process.env.WRITING_ROOM_TEST_DATABASE_URL;
if (!databaseUrl) {
  console.info('Skipping PostgreSQL tests: set WRITING_ROOM_TEST_DATABASE_URL after running npm run db:up.');
}

describe.skipIf(!databaseUrl)('PostgreSQL manuscript storage', () => {
  let admin: Pool;
  let pool: Pool;
  let repository: PostgresManuscriptRepository;
  let characters: PostgresCharactersRepository;
  // Identifiers cannot be bound in DDL. This one is built solely from a generated UUID.
  const schema = 'test_' + randomUUID().replaceAll('-', '');

  beforeAll(async () => {
    admin = createPostgresPool(databaseUrl!, 2);
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPostgresPool(databaseUrl!, 10, '-c search_path=' + schema);
    await Promise.all([migrate(pool), migrate(pool)]);
    repository = new PostgresManuscriptRepository(pool, () => contractTime);
    characters = new PostgresCharactersRepository(pool, () => contractTime);
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

  describe('characters storage', () => {
    async function seedFullCharacterWork(workId: string): Promise<number> {
      await pool.query(`
        INSERT INTO characters (work_id, kind, position, type)
        SELECT $1, 'folder', position, NULL FROM generate_series(0, $2::integer - 1) AS position
      `, [workId, characterLimits.nodes]);
      return 0;
    }

    async function seedValuesBudget(workId: string) {
      const count = characterLimits.workValues / characterLimits.values;
      const { rows: [full] } = await pool.query<{ id: string }>(`
        INSERT INTO characters (work_id, kind, position, field_values, values_bytes)
        SELECT $1, 'character', position, $3, $4 FROM generate_series(0, $2::integer - 1) AS position
        RETURNING id
      `, [workId, count, maxCharacterValue, characterLimits.values]);
      const { rows: [empty] } = await pool.query<{ id: string }>(`
        INSERT INTO characters (work_id, kind, position, field_values) VALUES ($1, 'character', $2, '{}')
        RETURNING id
      `, [workId, count]);
      return { revision: 0, emptyNodeId: empty.id, fullNodeId: full.id };
    }

    charactersStoreContract('repository contract', () => ({
      owner: characters.forUser(contractOwner),
      other: characters.forUser(contractOther),
      ownerWorks: repository.forUser(contractOwner),
      otherWorks: repository.forUser(contractOther),
      seedFullWork: seedFullCharacterWork,
      seedValuesBudget,
    }));

    describe('HTTP contract against PostgreSQL', () => {
      let api: Awaited<ReturnType<typeof startTestApi>>;
      beforeAll(async () => { api = await startTestApi({ store: 'postgres', repository, charactersRepository: characters }); });
      afterAll(async () => api.close());
      charactersStoreContract('HTTP', () => ({
        owner: httpCharactersStore(api.fetch, 'owner'),
        other: httpCharactersStore(api.fetch, 'other'),
        ownerWorks: httpContractStore(api.fetch, 'owner'),
        otherWorks: httpContractStore(api.fetch, 'other'),
        seedFullWork: seedFullCharacterWork,
        seedValuesBudget,
      }));
    });

    it('keeps revisions independent, updates recent work and preserves values when rearranging rows', async () => {
      const works = repository.forUser(contractOwner);
      let now = contractTime + 1;
      const characterStore = new PostgresCharactersRepository(pool, () => now).forUser(contractOwner);
      const { id } = await works.createWork({ title: 'Independent revisions' });
      const { node } = await characterStore.createNode(id, { kind: 'character', title: '', parentId: null }, 0);
      expect((await works.getWork(id)).updatedAt).toBe(now);
      expect((await works.getTree(id)).revision).toBe(0);
      await works.createNode(id, { kind: 'document', title: '', parentId: null }, 0);
      expect((await characterStore.getTree(id)).revision).toBe(1);
      const fieldValues = { old_field: '  보존🐈\n ' };
      now++;
      await characterStore.updateNode(id, node.id, { values: fieldValues, type: 'animal' }, 1);
      const { node: folder } = await characterStore.createNode(id, { kind: 'folder', title: '', parentId: null }, 2);
      await characterStore.moveNodes(id, [node.id], { parentId: folder.id }, 3);
      expect((await characterStore.getTree(id)).nodes[1]).toMatchObject({ values: fieldValues, type: 'animal' });
      expect((await works.getTree(id)).revision).toBe(1);

      now++;
      await characterStore.moveNodes(id, [node.id], { parentId: folder.id }, 4);
      expect((await works.getWork(id)).updatedAt).toBe(now - 1);
      await pool.query('DELETE FROM works WHERE id = $1', [id]);
      expect((await pool.query('SELECT id FROM characters WHERE work_id = $1', [id])).rows).toEqual([]);
      await expect(characterStore.getTree(id)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('upgrades a database with 0001–0004 applied and keeps existing manuscripts', async () => {
      const oldSchema = 'test_' + randomUUID().replaceAll('-', '');
      await admin.query('CREATE SCHEMA ' + oldSchema);
      const oldPool = createPostgresPool(databaseUrl!, 4, '-c search_path=' + oldSchema);
      try {
        await migrate(oldPool, [migration0001, migration0002, migration0003, migration0004]
          .map((sql, index) => ({ version: '000' + (index + 1), sql })));
        const oldRepository = new PostgresManuscriptRepository(oldPool);
        await oldRepository.ensureDevUser(contractOwner);
        const works = oldRepository.forUser(contractOwner);
        const { id } = await works.createWork({ title: 'Existing work' });
        const { node } = await works.createNode(id, { kind: 'document', title: 'Existing document', parentId: null }, 0);
        await works.writeDocument(id, node.id, 'Existing manuscript');

        await Promise.all([migrate(oldPool), migrate(oldPool)]);
        expect((await oldPool.query('SELECT version FROM schema_migrations ORDER BY version')).rows)
          .toContainEqual({ version: '0005' });
        const characterStore = new PostgresCharactersRepository(oldPool).forUser(contractOwner);
        expect(await characterStore.getTree(id)).toEqual({ revision: 0, nodes: [] });
        await characterStore.createNode(id, { kind: 'character', title: 'New character', parentId: null }, 0);
        expect((await works.getTree(id)).revision).toBe(1);
        expect((await works.readDocument(id, node.id)).content).toBe('Existing manuscript');
      } finally {
        await oldPool.end();
        await admin.query('DROP SCHEMA ' + oldSchema + ' CASCADE');
      }
    }, 25_000);
  });
});
