import { isRecord } from '../../../../platform/manuscript/common/manuscript.js';
import type { ManuscriptAuth } from '../common/manuscriptService.js';
import type { ManuscriptFetch } from './httpManuscriptStore.js';
import type { ManuscriptStatus } from './windowManuscriptService.js';

export class HttpManuscriptAuth implements ManuscriptAuth {
  private pending = false;

  constructor(
    private readonly status: ManuscriptStatus,
    private readonly fetcher: ManuscriptFetch = (path, init) => globalThis.fetch(path, init),
  ) {}

  async hasGoogle(): Promise<boolean> {
    const response = await this.fetcher('/api/auth/providers', { credentials: 'same-origin' });
    if (!response.ok) {
      return false;
    }
    const providers: unknown = await response.json();
    return Array.isArray(providers) && providers.includes('google');
  }

  signIn(email: string, password: string, createAccount: boolean): Promise<void> {
    return this.changeSession(createAccount ? 'signup' : 'login', createAccount ? 201 : 200,
      'Could not sign in. Try again.', { email, password });
  }

  signOut(): Promise<void> {
    return this.changeSession('logout', 204, 'Could not sign out. Try again.');
  }

  private async changeSession(
    action: 'signup' | 'login' | 'logout',
    expectedStatus: number,
    fallback: string,
    credentials?: { email: string; password: string },
  ): Promise<void> {
    if (this.pending) {
      throw new Error('An account request is already in progress.');
    }
    this.pending = true;
    try {
      const init: RequestInit = { method: 'POST', credentials: 'same-origin' };
      if (credentials) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(credentials);
      }
      const response = await this.fetcher('/api/auth/' + action, init).catch(() => undefined);
      if (response?.status !== expectedStatus) {
        const body: unknown = await response?.json().catch(() => undefined);
        const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
          ? body.error.message
          : fallback;
        throw new Error(message);
      }
      this.status.setAccount(action !== 'logout');
    } finally {
      this.pending = false;
    }
  }
}
