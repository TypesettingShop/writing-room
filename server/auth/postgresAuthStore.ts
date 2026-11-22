import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../store/transaction.js';
import type { ActiveSession, AuthStore, AuthUser, PasswordUser, SessionRecord } from './authStore.js';

async function insertSession(client: PoolClient, userId: string, session: SessionRecord): Promise<void> {
  await client.query(`
    INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
    VALUES ($1, $2, $3, $4, $3)
  `, [userId, session.tokenHash, session.createdAt, session.expiresAt]);
}

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly pool: Pool) {}

  async register(email: string, passwordHash: string, session: SessionRecord): Promise<AuthUser | undefined> {
    return inTransaction(this.pool, async client => {
      const { rows: [user] } = await client.query<AuthUser>(`
        INSERT INTO users (email, email_normalized, password_hash)
        VALUES ($1, $1, $2)
        ON CONFLICT (email_normalized) DO NOTHING
        RETURNING id, email
      `, [email, passwordHash]);
      if (user) {
        await insertSession(client, user.id, session);
      }
      return user;
    });
  }

  async findPasswordUser(email: string): Promise<PasswordUser | undefined> {
    const { rows: [user] } = await this.pool.query<PasswordUser>(`
      SELECT id, email, password_hash AS "passwordHash"
      FROM users WHERE email_normalized = $1 AND password_hash IS NOT NULL
    `, [email]);
    return user;
  }

  async createSession(userId: string, session: SessionRecord): Promise<void> {
    await inTransaction(this.pool, async client => {
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at <= $2', [userId, session.createdAt]);
      await insertSession(client, userId, session);
    });
  }

  async findSession(tokenHash: Buffer, now: Date): Promise<ActiveSession | undefined> {
    const { rows: [row] } = await this.pool.query<AuthUser & { token_hash: Buffer }>(`
      UPDATE sessions AS session SET last_seen_at = GREATEST(session.last_seen_at, $2)
      FROM users
      WHERE session.token_hash = $1 AND session.expires_at > $2 AND users.id = session.user_id
      RETURNING users.id, users.email, session.token_hash
    `, [tokenHash, now]);
    return row && { user: { id: row.id, email: row.email }, tokenHash: row.token_hash };
  }

  async deleteSession(tokenHash: Buffer): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async deleteExpiredSessions(now: Date): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
  }
}
