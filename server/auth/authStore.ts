import { randomUUID } from 'node:crypto';

export const sessionActivityIntervalMs = 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface PasswordUser extends AuthUser {
  passwordHash: string;
}

export interface GoogleIdentity {
  subject: string;
  email: string | null;
}

export interface SessionRecord {
  tokenHash: Buffer;
  createdAt: Date;
  expiresAt: Date;
}

export interface ActiveSession {
  user: AuthUser;
  tokenHash: Buffer;
}

export interface AuthStore {
  register(email: string, passwordHash: string, session: SessionRecord): Promise<AuthUser | undefined>;
  findPasswordUser(email: string): Promise<PasswordUser | undefined>;
  createSession(userId: string, session: SessionRecord): Promise<void>;
  signInWithGoogle(identity: GoogleIdentity, session: SessionRecord): Promise<AuthUser>;
  findSession(tokenHash: Buffer, now: Date): Promise<ActiveSession | undefined>;
  deleteSession(tokenHash: Buffer): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<void>;
}

export class MemoryAuthStore implements AuthStore {
  private readonly users = new Map<string, AuthUser>();
  private readonly googleUsers = new Map<string, AuthUser>();
  private readonly usersByEmail = new Map<string, PasswordUser>();
  private readonly sessions = new Map<string, SessionRecord & { userId: string; lastSeenAt: Date }>();

  async register(email: string, passwordHash: string, session: SessionRecord): Promise<AuthUser | undefined> {
    if (this.usersByEmail.has(email)) {
      return undefined;
    }
    const user = { id: randomUUID(), email };
    this.insertSession(user.id, session);
    this.users.set(user.id, user);
    this.usersByEmail.set(email, { ...user, passwordHash });
    return user;
  }

  async findPasswordUser(email: string): Promise<PasswordUser | undefined> {
    return this.usersByEmail.get(email);
  }

  async createSession(userId: string, session: SessionRecord): Promise<void> {
    if (!this.users.has(userId)) {
      throw new Error('Unknown user.');
    }
    this.insertSession(userId, session);
  }

  async signInWithGoogle(identity: GoogleIdentity, session: SessionRecord): Promise<AuthUser> {
    const existing = this.googleUsers.get(identity.subject);
    const user = { id: existing?.id ?? randomUUID(), email: identity.email ?? existing?.email ?? null };
    this.insertSession(user.id, session);
    this.users.set(user.id, user);
    this.googleUsers.set(identity.subject, user);
    return user;
  }

  private insertSession(userId: string, session: SessionRecord): void {
    const key = session.tokenHash.toString('hex');
    if (this.sessions.has(key)) {
      throw new Error('Duplicate session hash.');
    }
    for (const [hash, existing] of this.sessions) {
      if (existing.userId === userId && existing.expiresAt <= session.createdAt) {
        this.sessions.delete(hash);
      }
    }
    this.sessions.set(key, { ...session, userId, lastSeenAt: session.createdAt });
  }

  async findSession(tokenHash: Buffer, now: Date): Promise<ActiveSession | undefined> {
    const session = this.sessions.get(tokenHash.toString('hex'));
    if (!session || session.expiresAt <= now) {
      return undefined;
    }
    const user = this.users.get(session.userId);
    if (user) {
      if (now.getTime() - session.lastSeenAt.getTime() >= sessionActivityIntervalMs) {
        session.lastSeenAt = now;
      }
      return { user: { id: user.id, email: user.email }, tokenHash: session.tokenHash };
    }
    return undefined;
  }

  async deleteSession(tokenHash: Buffer): Promise<void> {
    this.sessions.delete(tokenHash.toString('hex'));
  }

  async deleteExpiredSessions(now: Date): Promise<void> {
    for (const [hash, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(hash);
      }
    }
  }
}
