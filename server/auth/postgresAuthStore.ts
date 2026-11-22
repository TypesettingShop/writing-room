import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../store/transaction.js';
import {
  sessionActivityIntervalMs, type ActiveSession, type AuthStore, type AuthUser, type GoogleIdentity, type PasswordUser, type SessionRecord,
} from './authStore.js';

async function insertSession(client: PoolClient, userId: string, session: SessionRecord): Promise<void> {
  await client.query(`
    INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
    VALUES ($1, $2, $3, $4, $3)
  `, [userId, session.tokenHash, session.createdAt, session.expiresAt]);
}

async function replaceExpiredSessions(client: PoolClient, userId: string, session: SessionRecord): Promise<void> {
  await client.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at <= $2', [userId, session.createdAt]);
  await insertSession(client, userId, session);
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
    await inTransaction(this.pool, client => replaceExpiredSessions(client, userId, session));
  }

  async signInWithGoogle(identity: GoogleIdentity, session: SessionRecord): Promise<AuthUser> {
    return inTransaction(this.pool, async client => {
      // Serialize first sign-ins for this identity so concurrent requests cannot create orphan users.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['oauth:google:' + identity.subject]);
      const { rows: [existing] } = await client.query<AuthUser>(`
        SELECT users.id, users.email FROM oauth_identities
        JOIN users ON users.id = oauth_identities.user_id
        WHERE provider = 'google' AND subject = $1
      `, [identity.subject]);
      if (existing) {
        if (identity.email !== null && identity.email !== existing.email) {
          await client.query('UPDATE users SET email = $2 WHERE id = $1', [existing.id, identity.email]);
          await client.query(`
            UPDATE oauth_identities SET email = $2 WHERE provider = 'google' AND subject = $1
          `, [identity.subject, identity.email]);
          existing.email = identity.email;
        }
        await replaceExpiredSessions(client, existing.id, session);
        return existing;
      }
      // Only password registrations claim email_normalized. Google accounts are keyed by subject.
      const { rows: [user] } = await client.query<AuthUser>(
        'INSERT INTO users (email) VALUES ($1) RETURNING id, email',
        [identity.email],
      );
      await client.query(`
        INSERT INTO oauth_identities (provider, subject, user_id, email)
        VALUES ('google', $1, $2, $3)
      `, [identity.subject, user.id, identity.email]);
      await insertSession(client, user.id, session);
      return user;
    });
  }

  async findSession(tokenHash: Buffer, now: Date): Promise<ActiveSession | undefined> {
    const { rows: [row] } = await this.pool.query<AuthUser & { token_hash: Buffer; last_seen_at: Date }>(`
      SELECT users.id, users.email, session.token_hash, session.last_seen_at
      FROM sessions AS session
      JOIN users ON users.id = session.user_id
      WHERE session.token_hash = $1 AND session.expires_at > $2
    `, [tokenHash, now]);
    if (!row) {
      return undefined;
    }
    const activityCutoff = new Date(now.getTime() - sessionActivityIntervalMs);
    if (row.last_seen_at <= activityCutoff) {
      await this.pool.query(`
        UPDATE sessions SET last_seen_at = $2
        WHERE token_hash = $1 AND expires_at > $2 AND last_seen_at <= $3
      `, [tokenHash, now, activityCutoff]);
    }
    return { user: { id: row.id, email: row.email }, tokenHash: row.token_hash };
  }

  async deleteSession(tokenHash: Buffer): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async deleteExpiredSessions(now: Date): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
  }
}
