import type { Pool, PoolClient } from 'pg';

export async function inTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await runTransaction(client, run);
  } finally {
    client.release(client.getTransactionStatus() !== 'I');
  }
}

export async function runTransaction<T>(client: PoolClient, run: (client: PoolClient) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
