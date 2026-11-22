import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { runTransaction } from './transaction.js';

const migrationFiles = import.meta.glob<string>('./migrations/*.sql', { eager: true, query: '?raw', import: 'default' });

export interface Migration {
  version: string;
  sql: string;
}

function bundledMigrations(): Migration[] {
  return Object.entries(migrationFiles).map(([path, sql]) => {
    const match = /\/(\d{4})_[a-z0-9_]+\.sql$/.exec(path);
    if (!match) {
      throw new Error('Invalid migration filename: ' + path);
    }
    return { version: match[1], sql };
  });
}

// Application-specific lock, held on one connection across individual migration transactions.
const lock = 7088787;

export async function migrate(pool: Pool, migrations: readonly Migration[] = bundledMigrations()): Promise<void> {
  const ordered = [...migrations].sort((a, b) => a.version.localeCompare(b.version));
  if (new Set(ordered.map(migration => migration.version)).size !== ordered.length) {
    throw new Error('Duplicate migration version.');
  }
  const client = await pool.connect();
  let locked = false;
  let reusable = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lock]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map(row => [row.version, row.checksum]));
    const pending = ordered.flatMap(({ version, sql }) => {
      const checksum = createHash('sha256').update(sql).digest('hex');
      const oldChecksum = applied.get(version);
      if (oldChecksum !== undefined && oldChecksum !== checksum) {
        throw new Error('Checksum changed for migration ' + version + '.');
      }
      return oldChecksum === undefined ? [{ version, sql, checksum }] : [];
    });
    for (const { version, sql, checksum } of pending) {
      await runTransaction(client, async () => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
      });
    }
  } finally {
    try {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock($1)', [lock]);
        reusable = client.getTransactionStatus() === 'I';
      }
    } finally {
      client.release(!reusable);
    }
  }
}
