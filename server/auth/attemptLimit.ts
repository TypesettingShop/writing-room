const windowMs = 15 * 60 * 1000;
const attemptsPerWindow = 10;
const maxKeys = 10_000;

interface Window {
  expiresAt: number;
  attempts: number;
}

function prune(windows: Map<string, Window>, now: number): void {
  for (const [key, window] of windows) {
    if (window.expiresAt > now) {
      break;
    }
    windows.delete(key);
  }
}

function evictOldest(windows: Map<string, Window>): void {
  const oldest = windows.keys().next();
  if (!oldest.done) {
    windows.delete(oldest.value);
  }
}

export class AttemptLimit {
  // Windows that still accept attempts, in creation order.
  private readonly open = new Map<string, Window>();
  // Exhausted windows, kept apart so a flood of new keys evicts open windows first.
  private readonly exhausted = new Map<string, Window>();

  /** Returns the remaining window in seconds when an attempt must wait. */
  take(ip: string, email: string, now: number): number | undefined {
    prune(this.open, now);
    prune(this.exhausted, now);
    const key = JSON.stringify([ip, email]);
    // A wall clock that steps back can leave an expired window behind a live one, so check expiry here too.
    const exhausted = this.exhausted.get(key);
    if (exhausted && exhausted.expiresAt > now) {
      return Math.ceil((exhausted.expiresAt - now) / 1000);
    }
    this.exhausted.delete(key);
    const window = this.open.get(key);
    if (window && window.expiresAt > now) {
      window.attempts++;
    } else {
      this.open.delete(key);
      if (this.open.size + this.exhausted.size >= maxKeys) {
        evictOldest(this.open.size > 0 ? this.open : this.exhausted);
      }
      this.open.set(key, { expiresAt: now + windowMs, attempts: 1 });
    }
    const current = this.open.get(key)!;
    if (current.attempts === attemptsPerWindow) {
      this.open.delete(key);
      this.exhausted.set(key, current);
    }
    return undefined;
  }
}
