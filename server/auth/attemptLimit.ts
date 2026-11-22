const windowMs = 15 * 60 * 1000;
const attemptsPerWindow = 10;
const maxKeys = 10_000;

export class AttemptLimit {
  private readonly windows = new Map<string, { expiresAt: number; attempts: number }>();

  /** Returns the remaining window in seconds when an attempt must wait. */
  take(ip: string, email: string, now: number): number | undefined {
    for (const [key, window] of this.windows) {
      if (window.expiresAt > now) {
        break;
      }
      this.windows.delete(key);
    }
    const key = JSON.stringify([ip, email]);
    const window = this.windows.get(key);
    if (window) {
      if (window.attempts === attemptsPerWindow) {
        return Math.ceil((window.expiresAt - now) / 1000);
      }
      window.attempts++;
    } else {
      if (this.windows.size === maxKeys) {
        const oldest = this.windows.keys().next();
        if (!oldest.done) {
          this.windows.delete(oldest.value);
        }
      }
      this.windows.set(key, { expiresAt: now + windowMs, attempts: 1 });
    }
    return undefined;
  }
}
