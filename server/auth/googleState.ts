import { matchesSecret, newSecret } from './session.js';

export const googleStateSeconds = 10 * 60;
const maxStates = 10_000;

interface PendingSignIn {
  browser: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
}

export class GoogleState {
  private readonly pending = new Map<string, PendingSignIn>();

  issue(browser: string, returnTo: string, now: number): { state: string; verifier: string; nonce: string } {
    this.prune(now);
    if (this.pending.size === maxStates) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) {
        this.pending.delete(oldest.value);
      }
    }
    const state = newSecret();
    const verifier = newSecret();
    const nonce = newSecret();
    this.pending.set(state, { browser, verifier, nonce, returnTo, expiresAt: now + googleStateSeconds * 1000 });
    return { state, verifier, nonce };
  }

  consume(state: string, browser: string | undefined, now: number): PendingSignIn | undefined {
    this.prune(now);
    const entry = this.pending.get(state);
    if (!entry || entry.expiresAt <= now || !matchesSecret(browser, entry.browser)) {
      return undefined;
    }
    this.pending.delete(state);
    return entry;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt > now) {
        break;
      }
      this.pending.delete(key);
    }
  }
}
